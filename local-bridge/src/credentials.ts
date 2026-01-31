// ── Credentials Manager ─────────────────────────────────────
// ~/.kakao-relay/credentials.json 관리 + 자동 갱신
// 민감값(토큰)은 로그에 절대 출력하지 않는다.

import { readFile, writeFile, mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

// ── Types ─────────────────────────────────────────────────

export interface Credentials {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch seconds
  relay_base_url?: string;
}

// ── Paths ─────────────────────────────────────────────────

const CREDENTIALS_DIR = join(homedir(), '.kakao-relay');
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.json');

export function getCredentialsPath(): string {
  return CREDENTIALS_FILE;
}

// ── Load ──────────────────────────────────────────────────

export async function loadCredentials(): Promise<Credentials | null> {
  try {
    const raw = await readFile(CREDENTIALS_FILE, 'utf-8');
    const data = JSON.parse(raw) as Credentials;
    if (!data.id_token || !data.refresh_token) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

// ── Save ──────────────────────────────────────────────────

export async function saveCredentials(creds: Credentials): Promise<void> {
  // 디렉토리 생성 (0700)
  await mkdir(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  // 파일 저장 (0600)
  const data = JSON.stringify(creds, null, 2) + '\n';
  await writeFile(CREDENTIALS_FILE, data, { mode: 0o600 });
}

// ── Token Validity Check ──────────────────────────────────

export function isTokenExpired(creds: Credentials): boolean {
  // 60초 여유를 두고 만료 판단
  return Date.now() / 1000 > creds.expires_at - 60;
}

// ── Refresh ───────────────────────────────────────────────

/**
 * POST /auth/refresh를 호출하여 토큰 갱신.
 * 갱신 성공 시 credentials.json도 업데이트한다.
 */
export async function refreshAndSave(
  relayBaseUrl: string,
  creds: Credentials,
): Promise<Credentials> {
  const url = `${relayBaseUrl}/auth/refresh`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: creds.refresh_token }),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    id_token: string;
    access_token: string;
    expires_in: number;
  };

  const updated: Credentials = {
    ...creds,
    id_token: data.id_token,
    access_token: data.access_token,
    expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
  };

  await saveCredentials(updated);
  return updated;
}

// ── Get Valid Token ───────────────────────────────────────

/**
 * credentials.json에서 유효한 id_token을 반환한다.
 * 만료 시 자동 갱신을 시도한다.
 * 실패하면 null을 반환한다.
 */
export async function getValidToken(relayBaseUrl: string): Promise<string | null> {
  let creds = await loadCredentials();
  if (!creds) return null;

  if (isTokenExpired(creds)) {
    try {
      creds = await refreshAndSave(relayBaseUrl, creds);
    } catch {
      return null;
    }
  }

  return creds.id_token;
}
