// ── Cognito Self-Service Onboarding Endpoints ───────────────
// GET  /auth/callback  — Cognito code→token (web portal)
// POST /auth/token     — Cognito code→token (CLI)
// POST /auth/refresh   — Cognito token refresh proxy
// GET  /auth/me        — User info + Kakao connect status
// GET  /auth/logout    — Redirect to Cognito logout

import { Router, Request, Response } from 'express';
import https from 'https';
import { requireAuth } from '../middleware/auth';
import { getKakaoTokens } from '../services/tokenVault';

const router = Router();

// ── ENV ────────────────────────────────────────────────────
const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN ?? '';
const COGNITO_APP_CLIENT_ID = process.env.COGNITO_APP_CLIENT_ID ?? '';
const COGNITO_APP_CLIENT_SECRET = process.env.COGNITO_APP_CLIENT_SECRET ?? '';
const CALLBACK_URL = process.env.CALLBACK_URL ?? '';
const LOGOUT_URL = process.env.LOGOUT_URL ?? '/';

// ── Helpers ────────────────────────────────────────────────

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

/**
 * Basic auth header for Cognito token endpoint.
 * base64(client_id:client_secret)
 */
function cognitoBasicAuth(): string {
  return Buffer.from(`${COGNITO_APP_CLIENT_ID}:${COGNITO_APP_CLIENT_SECRET}`).toString('base64');
}

/**
 * Exchange authorization code for tokens via Cognito token endpoint.
 * client_secret은 서버사이드에서만 사용.
 */
async function exchangeCognitoCode(
  code: string,
  redirectUri: string,
): Promise<{ id_token: string; access_token: string; refresh_token: string; expires_in: number }> {
  const tokenUrl = `https://${COGNITO_DOMAIN}/oauth2/token`;
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: COGNITO_APP_CLIENT_ID,
  });

  const res = await httpsPost(
    tokenUrl,
    {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${cognitoBasicAuth()}`,
    },
    params.toString(),
  );

  if (res.status !== 200) {
    console.error(`[cognito-auth] token exchange failed: status=${res.status}`);
    throw new Error(`Cognito token exchange failed: status=${res.status}`);
  }

  const data = JSON.parse(res.body) as {
    id_token: string;
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return data;
}

/**
 * Refresh tokens via Cognito token endpoint.
 * client_secret은 서버사이드에서만 사용.
 */
async function refreshCognitoToken(
  refreshToken: string,
): Promise<{ id_token: string; access_token: string; expires_in: number }> {
  const tokenUrl = `https://${COGNITO_DOMAIN}/oauth2/token`;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: COGNITO_APP_CLIENT_ID,
  });

  const res = await httpsPost(
    tokenUrl,
    {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${cognitoBasicAuth()}`,
    },
    params.toString(),
  );

  if (res.status !== 200) {
    console.error(`[cognito-auth] token refresh failed: status=${res.status}`);
    throw new Error(`Cognito token refresh failed: status=${res.status}`);
  }

  const data = JSON.parse(res.body) as {
    id_token: string;
    access_token: string;
    expires_in: number;
  };

  return data;
}

function isCognitoConfigured(): boolean {
  return !!(COGNITO_DOMAIN && COGNITO_APP_CLIENT_ID && COGNITO_APP_CLIENT_SECRET);
}

// ── GET /auth/callback ─────────────────────────────────────
// Web Portal: Cognito code→token 교환 후 HTML로 sessionStorage 저장

router.get('/auth/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  const error = req.query.error as string | undefined;

  if (error) {
    console.error(`[cognito-auth] callback error: ${error}`);
    res.status(400).send(errorHtml('로그인 오류', `인증 오류: ${error}`));
    return;
  }

  if (!code) {
    res.status(400).send(errorHtml('잘못된 요청', 'Authorization code가 없습니다.'));
    return;
  }

  if (!isCognitoConfigured()) {
    res.status(500).send(errorHtml('서버 설정 오류', 'Cognito가 구성되지 않았습니다.'));
    return;
  }

  try {
    const tokens = await exchangeCognitoCode(code, CALLBACK_URL);
    console.log('[cognito-auth] callback: code exchanged successfully');

    // HTML로 sessionStorage에 토큰 저장 후 dashboard로 리다이렉트
    res.status(200).send(tokenStorageHtml(tokens));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cognito-auth] callback error: ${msg}`);
    res.status(502).send(errorHtml('인증 실패', '토큰 교환 중 오류가 발생했습니다.'));
  }
});

// ── POST /auth/token ───────────────────────────────────────
// CLI용 code→token 교환. Body: { code, redirect_uri }

router.post('/auth/token', async (req: Request, res: Response) => {
  const { code, redirect_uri } = req.body as { code?: string; redirect_uri?: string };

  if (!code || !redirect_uri) {
    res.status(400).json({
      error: 'BAD_REQUEST',
      message: 'code and redirect_uri are required.',
    });
    return;
  }

  if (!isCognitoConfigured()) {
    res.status(500).json({
      error: 'SERVER_CONFIG_ERROR',
      message: 'Cognito is not configured.',
    });
    return;
  }

  try {
    const tokens = await exchangeCognitoCode(code, redirect_uri);
    console.log('[cognito-auth] token: code exchanged via CLI');
    res.status(200).json(tokens);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cognito-auth] token error: ${msg}`);
    res.status(502).json({
      error: 'COGNITO_TOKEN_ERROR',
      message: 'Failed to exchange authorization code.',
    });
  }
});

// ── POST /auth/refresh ─────────────────────────────────────
// 토큰 갱신 프록시. Body: { refresh_token }

router.post('/auth/refresh', async (req: Request, res: Response) => {
  const { refresh_token } = req.body as { refresh_token?: string };

  if (!refresh_token) {
    res.status(400).json({
      error: 'BAD_REQUEST',
      message: 'refresh_token is required.',
    });
    return;
  }

  if (!isCognitoConfigured()) {
    res.status(500).json({
      error: 'SERVER_CONFIG_ERROR',
      message: 'Cognito is not configured.',
    });
    return;
  }

  try {
    const tokens = await refreshCognitoToken(refresh_token);
    console.log('[cognito-auth] refresh: token refreshed');
    res.status(200).json(tokens);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cognito-auth] refresh error: ${msg}`);
    res.status(502).json({
      error: 'COGNITO_REFRESH_ERROR',
      message: 'Failed to refresh token.',
    });
  }
});

// ── GET /auth/me ───────────────────────────────────────────
// 사용자 정보 + 카카오 연동 상태

router.get('/auth/me', requireAuth, async (req: Request, res: Response) => {
  const userId = req.auth!.user_id;
  const authMethod = req.auth!.method;

  let kakaoInfo: { connected: boolean; kakao_user_key?: string; scope?: string } = {
    connected: false,
  };

  try {
    const tokens = await getKakaoTokens(userId);
    if (tokens) {
      kakaoInfo = {
        connected: true,
        kakao_user_key: tokens.kakao_user_key ?? undefined,
        scope: tokens.scope ?? undefined,
      };
    }
  } catch (err) {
    // DDB 조회 실패 시 연동 안됨으로 처리
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[cognito-auth] me: kakao lookup failed: ${msg}`);
  }

  res.status(200).json({
    user_id: userId,
    auth_method: authMethod,
    kakao: kakaoInfo,
  });
});

// ── GET /auth/logout ───────────────────────────────────────
// Cognito Hosted UI logout으로 리다이렉트

router.get('/auth/logout', (_req: Request, res: Response) => {
  if (!COGNITO_DOMAIN || !COGNITO_APP_CLIENT_ID) {
    res.redirect(LOGOUT_URL);
    return;
  }

  const params = new URLSearchParams({
    client_id: COGNITO_APP_CLIENT_ID,
    logout_uri: LOGOUT_URL,
  });

  const logoutUrl = `https://${COGNITO_DOMAIN}/logout?${params.toString()}`;
  res.redirect(logoutUrl);
});

// ── HTML Templates ─────────────────────────────────────────

function tokenStorageHtml(tokens: {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
}): string {
  // 토큰을 JSON으로 직렬화하여 HTML 내 script에 삽입
  // XSS 방지를 위해 </script> 이스케이프
  const safeTokens = JSON.stringify(tokens).replace(/<\//g, '<\\/');
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>로그인 완료</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; border-radius: 12px; padding: 2rem; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .spinner { width: 40px; height: 40px; border: 4px solid #e0e0e0; border-top: 4px solid #4a90d9; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 1rem; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <p>로그인 완료! 대시보드로 이동합니다...</p>
  </div>
  <script>
    try {
      var tokens = ${safeTokens};
      var expiresAt = Math.floor(Date.now() / 1000) + tokens.expires_in;
      sessionStorage.setItem('id_token', tokens.id_token);
      sessionStorage.setItem('access_token', tokens.access_token);
      sessionStorage.setItem('refresh_token', tokens.refresh_token);
      sessionStorage.setItem('expires_at', String(expiresAt));
      window.location.href = '/dashboard.html';
    } catch (e) {
      document.body.innerHTML = '<div class="card"><p>오류가 발생했습니다: ' + e.message + '</p></div>';
    }
  </script>
</body>
</html>`;
}

function errorHtml(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; border-radius: 12px; padding: 2rem; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); max-width: 400px; }
    .error { color: #d32f2f; }
    a { color: #4a90d9; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <h2 class="error">${title}</h2>
    <p>${message}</p>
    <p><a href="/">홈으로 돌아가기</a></p>
  </div>
</body>
</html>`;
}

export default router;
