// ── Kakao OAuth Connect (SaaS Mode B) ─────────────────────
// GET /auth/kakao/start   — Cognito JWT 필수, Kakao authorize URL로 redirect
// GET /auth/kakao/callback — state 기반 user_id 검증, 토큰 교환 + 저장

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import https from 'https';
import { requireAuth } from '../middleware/auth';
import { saveKakaoTokens } from '../services/tokenVault';

const router = Router();

// ── ENV ────────────────────────────────────────────────────
const KAKAO_CLIENT_ID = process.env.KAKAO_CLIENT_ID ?? '';
const KAKAO_CLIENT_SECRET = process.env.KAKAO_CLIENT_SECRET ?? '';
const KAKAO_REDIRECT_URI = process.env.KAKAO_REDIRECT_URI ?? '';
const KAKAO_OAUTH_SCOPES = process.env.KAKAO_OAUTH_SCOPES ?? 'talk_message';

// ── State Store (in-memory, 5분 TTL) ──────────────────────
const STATE_TTL_MS = 5 * 60 * 1000;
const stateStore = new Map<string, { user_id: string; created_at: number; return_to?: string }>();

function cleanExpiredStates(): void {
  const now = Date.now();
  for (const [key, val] of stateStore) {
    if (now - val.created_at > STATE_TTL_MS) {
      stateStore.delete(key);
    }
  }
}

// ── HTTPS 요청 헬퍼 ───────────────────────────────────────

interface HttpsResponse {
  status: number;
  body: string;
}

function httpsPost(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<HttpsResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(body).toString(),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(
  url: string,
  headers: Record<string, string>,
): Promise<HttpsResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ── GET /auth/kakao/start ─────────────────────────────────

router.get('/auth/kakao/start', requireAuth, (req: Request, res: Response) => {
  if (!KAKAO_CLIENT_ID || !KAKAO_REDIRECT_URI) {
    res.status(500).json({
      error: 'SERVER_CONFIG_ERROR',
      message: 'Kakao OAuth is not configured.',
    });
    return;
  }

  const userId = req.auth!.user_id;

  // state: random nonce (서버 저장 방식)
  const state = crypto.randomBytes(32).toString('hex');

  cleanExpiredStates();
  stateStore.set(state, { user_id: userId, created_at: Date.now() });

  const params = new URLSearchParams({
    client_id: KAKAO_CLIENT_ID,
    redirect_uri: KAKAO_REDIRECT_URI,
    response_type: 'code',
    scope: KAKAO_OAUTH_SCOPES,
    state,
  });

  const kakaoAuthorizeUrl = `https://kauth.kakao.com/oauth/authorize?${params.toString()}`;

  // 민감값 로그 금지 — user_id만 기록
  console.log(`[kakao-auth] start: user_id=${userId}`);
  res.redirect(kakaoAuthorizeUrl);
});

// ── GET /auth/kakao/start-url ────────────────────────────
// Web Portal용: JSON으로 authorize URL 반환 (fetch + Authorization 헤더)

router.get('/auth/kakao/start-url', requireAuth, (req: Request, res: Response) => {
  if (!KAKAO_CLIENT_ID || !KAKAO_REDIRECT_URI) {
    res.status(500).json({
      error: 'SERVER_CONFIG_ERROR',
      message: 'Kakao OAuth is not configured.',
    });
    return;
  }

  const userId = req.auth!.user_id;
  const returnTo = (req.query.return_to as string | undefined) ?? '';

  const state = crypto.randomBytes(32).toString('hex');

  cleanExpiredStates();
  stateStore.set(state, { user_id: userId, created_at: Date.now(), return_to: returnTo || undefined });

  const params = new URLSearchParams({
    client_id: KAKAO_CLIENT_ID,
    redirect_uri: KAKAO_REDIRECT_URI,
    response_type: 'code',
    scope: KAKAO_OAUTH_SCOPES,
    state,
  });

  const authorizeUrl = `https://kauth.kakao.com/oauth/authorize?${params.toString()}`;

  console.log(`[kakao-auth] start-url: user_id=${userId}`);
  res.status(200).json({ authorize_url: authorizeUrl });
});

// ── GET /auth/kakao/callback ──────────────────────────────

router.get('/auth/kakao/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;

  if (!code || !state) {
    res.status(400).json({
      error: 'BAD_REQUEST',
      message: 'Missing code or state parameter.',
    });
    return;
  }

  // ── state 검증 ──────────────────────────────────────────
  const stateEntry = stateStore.get(state);
  if (!stateEntry) {
    res.status(400).json({
      error: 'INVALID_STATE',
      message: 'Invalid or expired OAuth state.',
    });
    return;
  }

  if (Date.now() - stateEntry.created_at > STATE_TTL_MS) {
    stateStore.delete(state);
    res.status(400).json({
      error: 'EXPIRED_STATE',
      message: 'OAuth state has expired. Please try again.',
    });
    return;
  }

  // 일회성 사용: 즉시 삭제
  const returnTo = stateEntry.return_to;
  stateStore.delete(state);
  const userId = stateEntry.user_id;

  try {
    // ── code → access_token / refresh_token 교환 ──────────
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: KAKAO_CLIENT_ID,
      redirect_uri: KAKAO_REDIRECT_URI,
      code,
    });

    if (KAKAO_CLIENT_SECRET) {
      tokenParams.set('client_secret', KAKAO_CLIENT_SECRET);
    }

    const tokenRes = await httpsPost(
      'https://kauth.kakao.com/oauth/token',
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      tokenParams.toString(),
    );

    if (tokenRes.status !== 200) {
      // 민감값 로그 금지 — status만 기록
      console.error(`[kakao-auth] token exchange failed: status=${tokenRes.status}`);
      res.status(502).json({
        error: 'KAKAO_TOKEN_ERROR',
        message: 'Failed to exchange authorization code for tokens.',
      });
      return;
    }

    const tokenData = JSON.parse(tokenRes.body) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
      token_type: string;
    };

    // expires_at 계산 (epoch seconds)
    const expiresAt = Math.floor(Date.now() / 1000) + tokenData.expires_in;

    // ── kakao_user_key 조회 (best-effort) ─────────────────
    let kakaoUserKey: string | undefined;
    try {
      const userRes = await httpsGet(
        'https://kapi.kakao.com/v2/user/me',
        { Authorization: `Bearer ${tokenData.access_token}` },
      );
      if (userRes.status === 200) {
        const userData = JSON.parse(userRes.body);
        kakaoUserKey = String(userData.id);
      } else {
        console.warn(`[kakao-auth] user/me failed: status=${userRes.status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[kakao-auth] user/me error: ${msg}`);
    }

    // ── KMS 암호화 + DynamoDB 저장 ────────────────────────
    await saveKakaoTokens({
      user_id: userId,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token ?? '',
      expires_at: expiresAt,
      scope: tokenData.scope ?? KAKAO_OAUTH_SCOPES,
      kakao_user_key: kakaoUserKey,
    });

    // 민감값(토큰) 로그 금지 — 결과만 기록
    console.log(
      `[kakao-auth] callback: user_id=${userId} kakao_user_key=${kakaoUserKey ?? 'N/A'} stored`,
    );

    // return_to가 있으면 해당 URL로 리다이렉트 (상대경로만 허용)
    if (returnTo && returnTo.startsWith('/')) {
      const separator = returnTo.includes('?') ? '&' : '?';
      res.redirect(`${returnTo}${separator}kakao_connected=true`);
      return;
    }

    res.status(200).json({
      ok: true,
      message: '카카오 계정 연동이 완료되었습니다.',
      kakao_user_key: kakaoUserKey ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[kakao-auth] callback error: ${msg}`);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'An error occurred during Kakao OAuth callback.',
    });
  }
});

export default router;
