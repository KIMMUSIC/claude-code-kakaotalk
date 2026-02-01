// ── Kakao Outbound Sender ──────────────────────────────────
// BizMessage 알림톡(AT) + KakaoMemo(나에게 보내기) 발송 구현체 + No-op / Mock 모드

import https from 'https';
import http from 'http';
import { URL } from 'url';
import { getKakaoTokens, saveKakaoTokens } from '../services/tokenVault';

// ── ENV ────────────────────────────────────────────────────
const KAKAO_PROVIDER = process.env.KAKAO_PROVIDER ?? '';
const KAKAO_PROVIDER_MODE = process.env.KAKAO_PROVIDER_MODE ?? 'LIVE';
const KAKAO_CLIENT_ID = process.env.KAKAO_CLIENT_ID ?? '';
const KAKAO_CLIENT_SECRET = process.env.KAKAO_CLIENT_SECRET ?? '';

// ── Types ──────────────────────────────────────────────────

export interface SendQuestionInput {
  session_id: string;
  message_id: string;
  question_text: string;
  choices: string[];
  kakao_user_key: string;
  target_user_id?: string; // Mode B: DDB 토큰 조회용
}

export interface SendNotificationInput {
  session_id: string;
  text: string;
  severity: 'INFO' | 'WARNING' | 'DANGER';
  target_user_id?: string; // Mode B: DDB 토큰 조회용
}

export interface SendResult {
  ok: boolean;
  provider_message_id?: string;
  error_code?: string;
  error_message?: string;
}

export interface KakaoSender {
  sendQuestion(input: SendQuestionInput): Promise<SendResult>;
  sendNotification(input: SendNotificationInput): Promise<SendResult>;
}

export interface BizMessageConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  senderKey: string;
  templateCode: string;
  senderNo: string;
  phoneNumber: string;
}

// ── HTTP Utility ───────────────────────────────────────────

interface HttpResponse {
  status: number;
  body: string;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function httpRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          ...headers,
          ...(body ? { 'Content-Length': Buffer.byteLength(body).toString() } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Retry ──────────────────────────────────────────────────

const RETRY_DELAYS = [500, 1000, 2000];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status >= 500;
  return true; // network errors are retryable
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_DELAYS.length && isRetryable(err)) {
        await sleep(RETRY_DELAYS[attempt]);
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

// ── Message Builder (exported for testing) ─────────────────

export function buildMessageText(questionText: string, choices: string[]): string {
  let msg = questionText;
  if (choices.length > 0) {
    msg += '\n\n선택지: ' + choices.join(', ');
  }
  msg += '\n(응답: pending 또는 버튼 선택)';
  return msg;
}

// ── Kakao Memo Message Builder ────────────────────────────

export function buildMemoTemplateObject(questionText: string, choices: string[]): string {
  let text = '대기 질문이 있습니다.\n\n';
  text += questionText;
  if (choices.length > 0) {
    text += '\n\n선택지: ' + choices.join(', ');
  }
  text += '\n\n채널에서 pending을 입력하여 확인하세요.';

  return JSON.stringify({
    object_type: 'text',
    text,
    link: {
      web_url: 'https://vintagelane.store',
      mobile_web_url: 'https://vintagelane.store',
    },
  });
}

// ── Kakao Memo Notification Builder ─────────────────────────

export function buildMemoNotificationTemplate(text: string, severity: string): string {
  const prefix = severity === 'DANGER' ? '[긴급] '
    : severity === 'WARNING' ? '[주의] '
    : '';

  return JSON.stringify({
    object_type: 'text',
    text: `${prefix}${text}`,
    link: {
      web_url: 'https://vintagelane.store',
      mobile_web_url: 'https://vintagelane.store',
    },
  });
}

// ── Send Payload Builder (exported for testing) ────────────

export function buildSendPayload(
  config: BizMessageConfig,
  input: SendQuestionInput,
): Record<string, unknown> {
  return {
    message_type: 'AT',
    sender_key: config.senderKey,
    cid: input.message_id,
    template_code: config.templateCode,
    phone_number: config.phoneNumber,
    sender_no: config.senderNo,
    message: buildMessageText(input.question_text, input.choices),
    fall_back_yn: false,
  };
}

// ── Token Manager (BizMessage OAuth — exported for testing) ─

export class TokenManager {
  private accessToken: string | null = null;
  private expiresAt = 0;
  private static readonly REFRESH_MARGIN_MS = 60_000;

  constructor(
    private readonly baseUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  isExpired(): boolean {
    return !this.accessToken || Date.now() >= this.expiresAt - TokenManager.REFRESH_MARGIN_MS;
  }

  async getToken(): Promise<string> {
    if (!this.isExpired()) return this.accessToken!;
    return this.refresh();
  }

  /** For testing: inject token state */
  setToken(token: string, expiresAt: number): void {
    this.accessToken = token;
    this.expiresAt = expiresAt;
  }

  private async refresh(): Promise<string> {
    const url = `https://${this.baseUrl}/v2/oauth/token`;
    const body = 'grant_type=client_credentials';
    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const res = await withRetry(async () => {
      const r = await httpRequest(url, 'POST', {
        Accept: '*/*',
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      }, body);
      if (r.status >= 500) throw new HttpError(r.status, `OAuth server error: ${r.status}`);
      if (r.status >= 400) throw new HttpError(r.status, `OAuth client error: ${r.status}`);
      return r;
    });

    const data = JSON.parse(res.body);
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;

    // 비밀값 로그 금지 — 갱신 사실만 기록
    console.log('[kakao-sender] OAuth token refreshed');
    return this.accessToken!;
  }
}

// ── BizMessage Sender ──────────────────────────────────────

class BizMessageKakaoSender implements KakaoSender {
  private readonly tokenManager: TokenManager;

  constructor(private readonly config: BizMessageConfig) {
    this.tokenManager = new TokenManager(config.baseUrl, config.clientId, config.clientSecret);
  }

  async sendQuestion(input: SendQuestionInput): Promise<SendResult> {
    const { session_id, message_id } = input;

    try {
      const token = await this.tokenManager.getToken();
      const url = `https://${this.config.baseUrl}/v2/send/kakao`;
      const payload = JSON.stringify(buildSendPayload(this.config, input));

      const res = await withRetry(async () => {
        const r = await httpRequest(url, 'POST', {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        }, payload);
        if (r.status >= 500) throw new HttpError(r.status, `Send server error: ${r.status}`);
        if (r.status >= 400) throw new HttpError(r.status, `Send client error: ${r.status}`);
        return r;
      });

      const data = JSON.parse(res.body);
      // 비밀값 없이 결과만 로그
      console.log(`[sender_ok] session=${session_id} cid=${message_id}`);
      return {
        ok: true,
        provider_message_id: data.message_id ?? data.cid ?? message_id,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = err instanceof HttpError ? `HTTP_${err.status}` : 'NETWORK_ERROR';
      console.error(`[send_failed] session=${session_id} cid=${message_id} error=${code}`);
      return { ok: false, error_code: code, error_message: msg };
    }
  }

  async sendNotification(input: SendNotificationInput): Promise<SendResult> {
    const { session_id, text, severity } = input;
    try {
      const token = await this.tokenManager.getToken();
      const url = `https://${this.config.baseUrl}/v2/send/kakao`;
      const prefix = severity === 'DANGER' ? '[긴급] ' : severity === 'WARNING' ? '[주의] ' : '';
      const payload = JSON.stringify({
        message_type: 'AT',
        sender_key: this.config.senderKey,
        cid: session_id,
        template_code: this.config.templateCode,
        phone_number: this.config.phoneNumber,
        sender_no: this.config.senderNo,
        message: `${prefix}${text}`,
        fall_back_yn: false,
      });

      const res = await withRetry(async () => {
        const r = await httpRequest(url, 'POST', {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        }, payload);
        if (r.status >= 500) throw new HttpError(r.status, `Send server error: ${r.status}`);
        if (r.status >= 400) throw new HttpError(r.status, `Send client error: ${r.status}`);
        return r;
      });

      const data = JSON.parse(res.body);
      console.log(`[sender_ok] notify session=${session_id}`);
      return { ok: true, provider_message_id: data.message_id ?? session_id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = err instanceof HttpError ? `HTTP_${err.status}` : 'NETWORK_ERROR';
      console.error(`[send_failed] notify session=${session_id} error=${code}`);
      return { ok: false, error_code: code, error_message: msg };
    }
  }
}

// ── KakaoMemo Sender (나에게 보내기) ──────────────────────

class KakaoMemoSender implements KakaoSender {
  async sendQuestion(input: SendQuestionInput): Promise<SendResult> {
    const { session_id, message_id, target_user_id } = input;

    if (!target_user_id) {
      console.warn(`[kakao-memo] no target_user_id, skipping session=${session_id}`);
      return { ok: false, error_code: 'NO_TARGET_USER', error_message: 'target_user_id is required for kakao_memo' };
    }

    try {
      // ── 1) DDB에서 토큰 조회 ──────────────────────────────
      const tokens = await getKakaoTokens(target_user_id);
      if (!tokens) {
        console.warn(`[kakao-memo] no tokens for user=${target_user_id} session=${session_id}`);
        return { ok: false, error_code: 'NO_TOKENS', error_message: 'User has not connected Kakao account' };
      }

      let accessToken = tokens.access_token;

      // ── 2) 토큰 만료 시 refresh ───────────────────────────
      const nowEpoch = Math.floor(Date.now() / 1000);
      if (tokens.expires_at <= nowEpoch + 60) {
        const refreshed = await this.refreshAccessToken(tokens.refresh_token, target_user_id, tokens);
        if (!refreshed) {
          return { ok: false, error_code: 'REFRESH_FAILED', error_message: 'Failed to refresh Kakao access token' };
        }
        accessToken = refreshed;
      }

      // ── 3) 나에게 보내기 API 호출 ─────────────────────────
      const templateObject = buildMemoTemplateObject(input.question_text, input.choices);
      const body = `template_object=${encodeURIComponent(templateObject)}`;

      const res = await withRetry(async () => {
        const r = await httpRequest(
          'https://kapi.kakao.com/v2/api/talk/memo/default/send',
          'POST',
          {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        );
        if (r.status >= 500) throw new HttpError(r.status, `Kakao memo server error: ${r.status}`);
        if (r.status === 401) throw new HttpError(401, 'Kakao access token invalid');
        if (r.status >= 400) throw new HttpError(r.status, `Kakao memo client error: ${r.status}`);
        return r;
      });

      const data = JSON.parse(res.body);
      // 비밀값 없이 결과만 로그
      console.log(`[kakao-memo] sent session=${session_id} cid=${message_id} result_code=${data.result_code ?? 0}`);
      return { ok: true, provider_message_id: message_id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = err instanceof HttpError ? `HTTP_${err.status}` : 'NETWORK_ERROR';
      console.error(`[kakao-memo] failed session=${session_id} cid=${message_id} error=${code}`);
      return { ok: false, error_code: code, error_message: msg };
    }
  }

  private async refreshAccessToken(
    refreshToken: string,
    userId: string,
    existingTokens: { scope: string; kakao_user_key?: string },
  ): Promise<string | null> {
    try {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: KAKAO_CLIENT_ID,
        refresh_token: refreshToken,
      });
      if (KAKAO_CLIENT_SECRET) {
        params.set('client_secret', KAKAO_CLIENT_SECRET);
      }

      const res = await httpRequest(
        'https://kauth.kakao.com/oauth/token',
        'POST',
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        params.toString(),
      );

      if (res.status !== 200) {
        // 민감값 로그 금지
        console.error(`[kakao-memo] token refresh failed: status=${res.status}`);
        return null;
      }

      const data = JSON.parse(res.body) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };

      const expiresAt = Math.floor(Date.now() / 1000) + data.expires_in;

      // DDB에 갱신된 토큰 저장
      await saveKakaoTokens({
        user_id: userId,
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? refreshToken, // 새 refresh 없으면 기존 유지
        expires_at: expiresAt,
        scope: existingTokens.scope,
        kakao_user_key: existingTokens.kakao_user_key,
      });

      // 민감값 로그 금지
      console.log(`[kakao-memo] token refreshed for user=${userId}`);
      return data.access_token;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[kakao-memo] token refresh error: ${msg}`);
      return null;
    }
  }

  async sendNotification(input: SendNotificationInput): Promise<SendResult> {
    const { session_id, text, severity, target_user_id } = input;

    if (!target_user_id) {
      console.warn(`[kakao-memo] notify: no target_user_id, skipping session=${session_id}`);
      return { ok: false, error_code: 'NO_TARGET_USER', error_message: 'target_user_id is required for kakao_memo' };
    }

    try {
      const tokens = await getKakaoTokens(target_user_id);
      if (!tokens) {
        console.warn(`[kakao-memo] notify: no tokens for user=${target_user_id} session=${session_id}`);
        return { ok: false, error_code: 'NO_TOKENS', error_message: 'User has not connected Kakao account' };
      }

      let accessToken = tokens.access_token;

      const nowEpoch = Math.floor(Date.now() / 1000);
      if (tokens.expires_at <= nowEpoch + 60) {
        const refreshed = await this.refreshAccessToken(tokens.refresh_token, target_user_id, tokens);
        if (!refreshed) {
          return { ok: false, error_code: 'REFRESH_FAILED', error_message: 'Failed to refresh Kakao access token' };
        }
        accessToken = refreshed;
      }

      const templateObject = buildMemoNotificationTemplate(text, severity);
      const body = `template_object=${encodeURIComponent(templateObject)}`;

      const res = await withRetry(async () => {
        const r = await httpRequest(
          'https://kapi.kakao.com/v2/api/talk/memo/default/send',
          'POST',
          {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        );
        if (r.status >= 500) throw new HttpError(r.status, `Kakao memo server error: ${r.status}`);
        if (r.status === 401) throw new HttpError(401, 'Kakao access token invalid');
        if (r.status >= 400) throw new HttpError(r.status, `Kakao memo client error: ${r.status}`);
        return r;
      });

      const data = JSON.parse(res.body);
      console.log(`[kakao-memo] notify sent session=${session_id} result_code=${data.result_code ?? 0}`);
      return { ok: true, provider_message_id: session_id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = err instanceof HttpError ? `HTTP_${err.status}` : 'NETWORK_ERROR';
      console.error(`[kakao-memo] notify failed session=${session_id} error=${code}`);
      return { ok: false, error_code: code, error_message: msg };
    }
  }
}

// ── Mock Senders ──────────────────────────────────────────

class MockBizMessageKakaoSender implements KakaoSender {
  async sendQuestion(input: SendQuestionInput): Promise<SendResult> {
    console.log(`[sender_ok] MOCK bizmessage session=${input.session_id} cid=${input.message_id}`);
    return { ok: true, provider_message_id: `mock-${input.message_id}` };
  }

  async sendNotification(input: SendNotificationInput): Promise<SendResult> {
    console.log(`[sender_ok] MOCK bizmessage notify session=${input.session_id}`);
    return { ok: true, provider_message_id: `mock-notify-${input.session_id}` };
  }
}

class MockKakaoMemoSender implements KakaoSender {
  async sendQuestion(input: SendQuestionInput): Promise<SendResult> {
    console.log(`[sender_ok] MOCK kakao_memo session=${input.session_id} cid=${input.message_id} user=${input.target_user_id ?? 'N/A'}`);
    return { ok: true, provider_message_id: `mock-memo-${input.message_id}` };
  }

  async sendNotification(input: SendNotificationInput): Promise<SendResult> {
    console.log(`[sender_ok] MOCK kakao_memo notify session=${input.session_id} user=${input.target_user_id ?? 'N/A'}`);
    return { ok: true, provider_message_id: `mock-memo-notify-${input.session_id}` };
  }
}

// ── No-op Sender ───────────────────────────────────────────

class NoopKakaoSender implements KakaoSender {
  async sendQuestion(_input: SendQuestionInput): Promise<SendResult> {
    return { ok: true };
  }

  async sendNotification(_input: SendNotificationInput): Promise<SendResult> {
    return { ok: true };
  }
}

// ── Factory ────────────────────────────────────────────────

function loadBizMessageConfig(): BizMessageConfig | null {
  const clientId = process.env.KAKAO_OAUTH_CLIENT_ID ?? '';
  const clientSecret = process.env.KAKAO_OAUTH_SECRET ?? '';
  const senderKey = process.env.KAKAO_SENDER_KEY ?? '';
  const templateCode = process.env.KAKAO_TEMPLATE_CODE ?? '';
  const senderNo = process.env.KAKAO_SENDER_NO ?? '';
  const phoneNumber = process.env.KAKAO_PHONE_NUMBER ?? '';

  const missing: string[] = [];
  if (!clientId) missing.push('KAKAO_OAUTH_CLIENT_ID');
  if (!clientSecret) missing.push('KAKAO_OAUTH_SECRET');
  if (!senderKey) missing.push('KAKAO_SENDER_KEY');
  if (!templateCode) missing.push('KAKAO_TEMPLATE_CODE');
  if (!senderNo) missing.push('KAKAO_SENDER_NO');
  if (!phoneNumber) missing.push('KAKAO_PHONE_NUMBER');

  if (missing.length > 0) {
    console.warn(`[kakao-sender] missing env: ${missing.join(', ')} — sender disabled`);
    return null;
  }

  return {
    baseUrl: process.env.KAKAO_BASE_URL ?? 'bizmsg-web.kakaoenterprise.com',
    clientId,
    clientSecret,
    senderKey,
    templateCode,
    senderNo,
    phoneNumber,
  };
}

function createSender(): { sender: KakaoSender; enabled: boolean } {
  // ── kakao_memo ──────────────────────────────────────────
  if (KAKAO_PROVIDER === 'kakao_memo') {
    if (KAKAO_PROVIDER_MODE === 'MOCK') {
      console.log('[kakao-sender] provider=kakao_memo mode=MOCK');
      return { sender: new MockKakaoMemoSender(), enabled: true };
    }
    if (!KAKAO_CLIENT_ID) {
      console.warn('[kakao-sender] KAKAO_CLIENT_ID missing — kakao_memo sender disabled');
      return { sender: new NoopKakaoSender(), enabled: false };
    }
    console.log('[kakao-sender] provider=kakao_memo mode=LIVE');
    return { sender: new KakaoMemoSender(), enabled: true };
  }

  // ── bizmessage ──────────────────────────────────────────
  if (KAKAO_PROVIDER === 'bizmessage') {
    if (KAKAO_PROVIDER_MODE === 'MOCK') {
      console.log('[kakao-sender] provider=bizmessage mode=MOCK');
      return { sender: new MockBizMessageKakaoSender(), enabled: true };
    }
    const config = loadBizMessageConfig();
    if (!config) {
      return { sender: new NoopKakaoSender(), enabled: false };
    }
    console.log('[kakao-sender] provider=bizmessage mode=LIVE');
    return { sender: new BizMessageKakaoSender(config), enabled: true };
  }

  // ── noop (default) ──────────────────────────────────────
  return { sender: new NoopKakaoSender(), enabled: false };
}

const { sender, enabled } = createSender();

export const kakaoSender: KakaoSender = sender;
export const senderEnabled: boolean = enabled;
