import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

// ── Mode A: Static token ────────────────────────────────────
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? '';

// ── Mode B: Cognito JWT ─────────────────────────────────────
const COGNITO_REGION = process.env.COGNITO_REGION ?? '';
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? '';
const COGNITO_APP_CLIENT_ID = process.env.COGNITO_APP_CLIENT_ID ?? '';

const cognitoEnabled = !!(COGNITO_REGION && COGNITO_USER_POOL_ID && COGNITO_APP_CLIENT_ID);

const COGNITO_ISSUER = cognitoEnabled
  ? `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}`
  : '';

const jwksRsa = cognitoEnabled
  ? jwksClient({
      jwksUri: `${COGNITO_ISSUER}/.well-known/jwks.json`,
      cache: true,
      cacheMaxAge: 600_000, // 10분
      rateLimit: true,
      jwksRequestsPerMinute: 10,
    })
  : null;

/**
 * JWKS에서 kid로 서명 키를 조회한다.
 */
function getSigningKey(kid: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!jwksRsa) {
      reject(new Error('JWKS client not initialised'));
      return;
    }
    jwksRsa.getSigningKey(kid, (err, key) => {
      if (err) {
        reject(err);
        return;
      }
      if (!key) {
        reject(new Error('Signing key not found'));
        return;
      }
      resolve(key.getPublicKey());
    });
  });
}

/**
 * Cognito JWT를 검증하고 payload를 반환한다.
 * 검증 항목: 서명(JWKS), iss, aud/client_id, exp, token_use
 */
async function verifyCognitoJwt(token: string): Promise<{ sub: string }> {
  // 1) 헤더에서 kid 추출 (서명 검증 전 디코딩)
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === 'string' || !decoded.header.kid) {
    throw new Error('Invalid JWT structure');
  }

  // 2) JWKS에서 public key 가져오기
  const publicKey = await getSigningKey(decoded.header.kid);

  // 3) 서명 + claims 검증
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      publicKey,
      {
        issuer: COGNITO_ISSUER,
        algorithms: ['RS256'],
      },
      (err, payload) => {
        if (err) {
          reject(err);
          return;
        }

        if (!payload || typeof payload === 'string') {
          reject(new Error('Invalid JWT payload'));
          return;
        }

        // token_use 체크: id token은 aud, access token은 client_id
        const tokenUse = (payload as Record<string, unknown>).token_use as string | undefined;

        if (tokenUse === 'id') {
          // ID token: aud == client_id
          if (payload.aud !== COGNITO_APP_CLIENT_ID) {
            reject(new Error('ID token aud mismatch'));
            return;
          }
        } else if (tokenUse === 'access') {
          // Access token: client_id claim
          const clientId = (payload as Record<string, unknown>).client_id as string | undefined;
          if (clientId !== COGNITO_APP_CLIENT_ID) {
            reject(new Error('Access token client_id mismatch'));
            return;
          }
        } else {
          reject(new Error('Unknown token_use'));
          return;
        }

        if (!payload.sub || typeof payload.sub !== 'string') {
          reject(new Error('Missing sub claim'));
          return;
        }

        resolve({ sub: payload.sub });
      },
    );
  });
}

/**
 * 인증 미들웨어.
 *
 * 1) AUTH_TOKEN 일치 → Mode A (static_token) 통과
 * 2) Cognito JWT 검증 성공 → Mode B (cognito_jwt) 통과, req.auth.user_id = sub
 * 3) 둘 다 실패 → 401
 *
 * 민감값(토큰, 시크릿)은 로그에 출력하지 않는다.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Missing or invalid Authorization header.',
    });
    return;
  }

  const token = header.slice('Bearer '.length);

  // ── Mode A: static AUTH_TOKEN ─────────────────────────────
  if (AUTH_TOKEN && token === AUTH_TOKEN) {
    req.auth = { user_id: 'static-token', method: 'static_token' };
    next();
    return;
  }

  // ── Mode B: Cognito JWT ───────────────────────────────────
  if (!cognitoEnabled) {
    // Cognito 미설정이고 static token도 불일치
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Invalid token.',
    });
    return;
  }

  verifyCognitoJwt(token)
    .then(({ sub }) => {
      req.auth = { user_id: sub, method: 'cognito_jwt' };
      next();
    })
    .catch((err) => {
      // 민감값 출력 금지 — 에러 메시지만 기록
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[auth] JWT verification failed: ${msg}`);
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Invalid token.',
      });
    });
}
