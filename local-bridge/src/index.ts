import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadCredentials, refreshAndSave, isTokenExpired } from './credentials.js';

// ── ENV ─────────────────────────────────────────────────────
let RELAY_BASE_URL = (process.env.RELAY_BASE_URL ?? '').replace(/\/+$/, '');
const DEBUG = process.env.DEBUG === '1';

// 인증 토큰: env var fallback (credentials.ts 없을 때)
const ENV_AUTH_TOKEN = process.env.COGNITO_ID_TOKEN
  ?? process.env.COGNITO_ACCESS_TOKEN
  ?? process.env.AUTH_TOKEN
  ?? '';

// 현재 사용 중인 토큰 (credentials.ts 또는 env var)
let currentAuthToken = '';
let authSource = 'none';

// Mode B: target_user_id 기본값 (tool argument로 안 넘어올 때 사용)
const DEFAULT_TARGET_USER_ID = process.env.TARGET_USER_ID ?? '';

// ── Logging (stderr only — stdout is MCP protocol) ─────────
function debug(...args: unknown[]): void {
  if (DEBUG) console.error('[local-bridge:debug]', ...args);
}

function log(...args: unknown[]): void {
  console.error('[local-bridge]', ...args);
}

// ── Helpers ─────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch wrapper: Authorization 헤더 자동 삽입 + per-request timeout.
 * 토큰은 절대 로그에 출력하지 않는다.
 */
async function relayFetch(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 30_000, ...fetchOpts } = options;
  const url = `${RELAY_BASE_URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    debug(`${fetchOpts.method ?? 'GET'} ${url}`);
    return await fetch(url, {
      ...fetchOpts,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${currentAuthToken}`,
        ...(fetchOpts.headers as Record<string, string> | undefined),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 401 수신 시 토큰 갱신 + 재시도 (1회).
 * credentials.json 기반 인증일 때만 갱신 시도.
 */
async function relayFetchWithRefresh(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const res = await relayFetch(path, options);

  if (res.status === 401 && authSource === 'credentials') {
    debug('401 received, attempting token refresh...');
    try {
      const creds = await loadCredentials();
      if (creds) {
        const updated = await refreshAndSave(RELAY_BASE_URL, creds);
        currentAuthToken = updated.id_token;
        debug('token refreshed, retrying request');
        return await relayFetch(path, options);
      }
    } catch (err) {
      debug(`token refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return res;
}

/**
 * 네트워크 에러 시 지수 백오프 재시도 (최대 3회).
 * HTTP 응답(4xx/5xx 포함)은 재시도하지 않는다 — fetch가 throw할 때만 재시도.
 */
async function withRetry(fn: () => Promise<Response>): Promise<Response> {
  const DELAYS = [500, 1000, 2000];
  const MAX_RETRIES = 3;
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // fetch failed의 근본 원인 (cause) 출력
      const msg = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && (err as NodeJS.ErrnoException).cause
        ? String((err as NodeJS.ErrnoException).cause)
        : '';
      const code = err instanceof Error ? (err as NodeJS.ErrnoException).code ?? '' : '';
      debug(`network error [${code}]: ${msg}${cause ? ` cause=${cause}` : ''}`);
      if (attempt < MAX_RETRIES) {
        const delay = DELAYS[attempt] ?? 2000;
        debug(`retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

/**
 * 에러의 근본 원인을 재귀적으로 파악하여 문자열로 반환한다.
 * AggregateError, cause chain을 모두 풀어낸다.
 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  let msg = err.message;
  const anyErr = err as unknown as Record<string, unknown>;
  if (anyErr.code) msg += ` (code=${anyErr.code})`;
  if (anyErr.cause instanceof AggregateError) {
    const subs = anyErr.cause.errors.map((e: unknown) => describeError(e));
    msg += ` [AggregateError: ${subs.join('; ')}]`;
  } else if (anyErr.cause instanceof Error) {
    msg += ` [cause: ${describeError(anyErr.cause)}]`;
  } else if (anyErr.cause) {
    msg += ` [cause: ${String(anyErr.cause)}]`;
  }
  return msg;
}

// ── Tool: kakao.ask_user ────────────────────────────────────
interface AskUserInput {
  session_id: string;
  text: string;
  choices?: string[];
  timeout_sec?: number;
  severity?: 'INFO' | 'WARNING' | 'DANGER';
  target_user_id?: string; // Mode B
}

interface AskUserOutput {
  status: 'RESOLVED' | 'EXPIRED' | 'CANCELED' | 'ERROR';
  reply_text?: string;
  choice?: string;
  reply_id?: string;
  error_code?: string;
  error_message?: string;
}

async function askUser(input: AskUserInput): Promise<AskUserOutput> {
  const {
    session_id,
    text,
    choices,
    timeout_sec = 120,
    severity = 'INFO',
    target_user_id,
  } = input;

  // target_user_id: argument > env fallback
  const resolvedTargetUserId = target_user_id || DEFAULT_TARGET_USER_ID || undefined;

  const sessionPath = `/v1/sessions/${encodeURIComponent(session_id)}`;

  // ── Step 1: Post question ──────────────────────────────────
  const questionBody: Record<string, unknown> = { text, choices, timeout_sec, severity };
  if (resolvedTargetUserId) {
    questionBody.target_user_id = resolvedTargetUserId;
  }

  let questionRes: Response;
  try {
    questionRes = await withRetry(() =>
      relayFetchWithRefresh(`${sessionPath}/questions`, {
        method: 'POST',
        body: JSON.stringify(questionBody),
      }),
    );
  } catch (err) {
    return {
      status: 'ERROR',
      error_code: 'NETWORK_ERROR',
      error_message: `Failed to post question: ${describeError(err)}`,
    };
  }

  if (questionRes.status === 401) {
    return { status: 'ERROR', error_code: 'UNAUTHORIZED', error_message: 'Authentication failed.' };
  }
  if (questionRes.status === 403) {
    const body = (await questionRes.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      status: 'ERROR',
      error_code: 'FORBIDDEN',
      error_message: (body.message as string) ?? 'Permission denied.',
    };
  }
  if (questionRes.status === 409) {
    const body = (await questionRes.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      status: 'ERROR',
      error_code: 'PENDING_EXISTS',
      error_message: (body.message as string) ?? 'A pending question already exists.',
    };
  }
  if (questionRes.status !== 201) {
    const body = (await questionRes.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      status: 'ERROR',
      error_code: `HTTP_${questionRes.status}`,
      error_message: (body.message as string) ?? `Unexpected status ${questionRes.status}`,
    };
  }

  debug(`question posted for session ${session_id}`);

  // ── Step 2: Long poll for replies ──────────────────────────
  const POLL_WAIT = 25; // seconds per poll request
  const deadline = Date.now() + timeout_sec * 1000;

  while (Date.now() < deadline) {
    const remainingSec = Math.ceil((deadline - Date.now()) / 1000);
    const waitSec = Math.min(POLL_WAIT, remainingSec, 60);
    if (waitSec <= 0) break;

    let pollRes: Response;
    try {
      pollRes = await withRetry(() =>
        relayFetchWithRefresh(`${sessionPath}/replies?wait_sec=${waitSec}`, {
          timeoutMs: (waitSec + 10) * 1000,
        }),
      );
    } catch (err) {
      return {
        status: 'ERROR',
        error_code: 'NETWORK_ERROR',
        error_message: `Failed to poll replies: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (pollRes.status !== 200) {
      return {
        status: 'ERROR',
        error_code: `HTTP_${pollRes.status}`,
        error_message: `Unexpected poll status ${pollRes.status}`,
      };
    }

    const data = (await pollRes.json()) as {
      session_id: string;
      status: string;
      replies: Array<{
        reply_id: string;
        type: string;
        text?: string;
        choice?: string;
        created_at: string;
      }>;
    };

    // reply가 1개라도 오면 첫 reply를 채택
    if (data.replies && data.replies.length > 0) {
      const reply = data.replies[0];
      return {
        status: 'RESOLVED',
        reply_text: reply.text,
        choice: reply.choice,
        reply_id: reply.reply_id,
      };
    }

    // 서버 측 상태 변경 감지
    if (data.status === 'EXPIRED') return { status: 'EXPIRED' };
    if (data.status === 'CANCELED') return { status: 'CANCELED' };
  }

  return { status: 'EXPIRED' };
}

// ── MCP Server ──────────────────────────────────────────────
const server = new Server(
  { name: 'kakao-local-bridge', version: '0.2.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'kakao.ask_user',
      description:
        'Send a question to the user via KakaoTalk and wait for their reply. ' +
        'Returns RESOLVED with the reply, or EXPIRED/ERROR on failure.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: {
            type: 'string',
            description: 'UUID v4 session identifier',
          },
          text: {
            type: 'string',
            description: 'Question text to send to the user',
          },
          choices: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional predefined answer choices',
          },
          timeout_sec: {
            type: 'number',
            description: 'Timeout in seconds (default: 120)',
          },
          severity: {
            type: 'string',
            enum: ['INFO', 'WARNING', 'DANGER'],
            description: 'Severity level (default: INFO)',
          },
          target_user_id: {
            type: 'string',
            description: 'Target user ID (Cognito sub) for SaaS mode. Falls back to TARGET_USER_ID env.',
          },
        },
        required: ['session_id', 'text'],
      },
    },
    {
      name: 'kakao.notify_user',
      description:
        'Send a notification to the user via KakaoTalk. Fire-and-forget — no reply expected.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: {
            type: 'string',
            description: 'UUID v4 session identifier',
          },
          text: {
            type: 'string',
            description: 'Notification text',
          },
          severity: {
            type: 'string',
            enum: ['INFO', 'WARNING', 'DANGER'],
            description: 'Severity level (default: INFO)',
          },
          target_user_id: {
            type: 'string',
            description: 'Target user ID (Cognito sub) for SaaS mode. Falls back to TARGET_USER_ID env.',
          },
        },
        required: ['session_id', 'text'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'kakao.ask_user') {
    const input = (args ?? {}) as unknown as AskUserInput;
    if (!input.session_id || !input.text) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status: 'ERROR',
              error_code: 'INVALID_INPUT',
              error_message: 'session_id and text are required.',
            }),
          },
        ],
        isError: true,
      };
    }
    const result = await askUser(input);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      isError: result.status === 'ERROR',
    };
  }

  if (name === 'kakao.notify_user') {
    const { session_id, text, severity, target_user_id } = (args ?? {}) as {
      session_id: string;
      text: string;
      severity?: string;
      target_user_id?: string;
    };

    if (!session_id || !text) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error_code: 'INVALID_INPUT',
              error_message: 'session_id and text are required.',
            }),
          },
        ],
        isError: true,
      };
    }

    const resolvedTargetUserId = target_user_id || DEFAULT_TARGET_USER_ID || undefined;

    const notifyBody: Record<string, unknown> = {
      session_id,
      text,
      severity: severity ?? 'INFO',
    };
    if (resolvedTargetUserId) {
      notifyBody.target_user_id = resolvedTargetUserId;
    }

    try {
      const res = await withRetry(() =>
        relayFetchWithRefresh('/v1/notify', {
          method: 'POST',
          body: JSON.stringify(notifyBody),
        }),
      );

      if (res.status === 401) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error_code: 'UNAUTHORIZED', error_message: 'Authentication failed.' }) }],
          isError: true,
        };
      }

      const data = (await res.json()) as Record<string, unknown>;
      const isOk = res.status >= 200 && res.status < 300 && data.ok === true;

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
        isError: !isOk,
      };
    } catch (err) {
      const errMsg = describeError(err);
      log(`[notify] network error: ${errMsg}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error_code: 'NETWORK_ERROR',
              error_message: `Failed to send notification: ${errMsg}`,
            }),
          },
        ],
        isError: true,
      };
    }
  }

  return {
    content: [
      { type: 'text' as const, text: JSON.stringify({ error: 'Unknown tool', name }) },
    ],
    isError: true,
  };
});

// ── Auth Initialization ─────────────────────────────────────

async function initAuth(): Promise<void> {
  // 1. credentials.json에서 토큰 + relay_base_url 로드 시도
  const creds = await loadCredentials();

  // credentials.json의 relay_base_url이 가장 신뢰할 수 있는 소스 (CLI 로그인 시 설정됨)
  if (creds?.relay_base_url) {
    RELAY_BASE_URL = creds.relay_base_url.replace(/\/+$/, '');
  }

  // 최종 fallback
  if (!RELAY_BASE_URL) {
    RELAY_BASE_URL = 'http://localhost:3000';
  }

  // 토큰 로드: credentials.json 우선
  if (creds) {
    if (isTokenExpired(creds)) {
      try {
        const updated = await refreshAndSave(RELAY_BASE_URL, creds);
        currentAuthToken = updated.id_token;
      } catch (err) {
        debug(`token refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        // 만료된 토큰이라도 일단 사용 시도 (서버가 거부하면 그때 에러)
        currentAuthToken = creds.id_token;
      }
    } else {
      currentAuthToken = creds.id_token;
    }
    authSource = 'credentials';
    debug('auth: credentials file');
    return;
  }

  // 2. env var fallback
  if (ENV_AUTH_TOKEN) {
    currentAuthToken = ENV_AUTH_TOKEN;
    if (process.env.COGNITO_ID_TOKEN) {
      authSource = 'env_cognito_id';
    } else if (process.env.COGNITO_ACCESS_TOKEN) {
      authSource = 'env_cognito_access';
    } else {
      authSource = 'env_static_token';
    }
    debug(`auth: ${authSource}`);
    return;
  }

  console.error('[FATAL] 인증 토큰이 없습니다. kakao-relay-login으로 로그인하거나 COGNITO_ID_TOKEN/AUTH_TOKEN을 설정하세요.');
  process.exit(1);
}

// ── Main ────────────────────────────────────────────────────
async function main(): Promise<void> {
  await initAuth();

  debug(`relay: ${RELAY_BASE_URL}`);
  debug(`auth source: ${authSource}`);
  if (DEFAULT_TARGET_USER_ID) {
    debug(`default target_user_id: ${DEFAULT_TARGET_USER_ID}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
