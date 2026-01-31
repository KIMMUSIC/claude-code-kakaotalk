#!/usr/bin/env node
// ── CLI Login Tool ──────────────────────────────────────────
// 브라우저 기반 Cognito 로그인 → credentials.json 저장
// 민감값(토큰)은 로그에 절대 출력하지 않는다.

import http from 'http';
import { URL } from 'url';
import { saveCredentials, getCredentialsPath } from './credentials.js';

// ── Config ────────────────────────────────────────────────
const DEFAULT_PORT = 19281;
const TIMEOUT_SEC = 120;

const COGNITO_DOMAIN = 'kakao-relay.auth.ap-northeast-2.amazoncognito.com';
const COGNITO_CLIENT_ID = '2nrjsv33bdmk7rfar5ptmveb80';
const OAUTH_SCOPES = 'openid email profile';

const RELAY_BASE_URL = process.env.RELAY_BASE_URL ?? 'https://vintagelane.store';

// ── Parse CLI args ────────────────────────────────────────
function parseArgs(): { port: number } {
  const args = process.argv.slice(2);
  let port = DEFAULT_PORT;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(`Invalid port: ${args[i + 1]}`);
        process.exit(1);
      }
      i++;
    }
    if (args[i] === '--help' || args[i] === '-h') {
      console.log(`Usage: kakao-relay-login [--port <port>]`);
      console.log(`  --port  Local callback port (default: ${DEFAULT_PORT})`);
      process.exit(0);
    }
  }

  return { port };
}

// ── Open browser ──────────────────────────────────────────
async function openBrowser(url: string): Promise<void> {
  try {
    // Dynamic import for ESM compatibility
    const open = (await import('open')).default;
    await open(url);
  } catch {
    console.log(`\nPlease open this URL in your browser:\n${url}\n`);
  }
}

// ── Exchange code via relay ───────────────────────────────
async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<{ id_token: string; access_token: string; refresh_token: string; expires_in: number }> {
  const url = `${RELAY_BASE_URL}/auth/token`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirect_uri: redirectUri }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed: HTTP ${res.status} — ${body}`);
  }

  return (await res.json()) as {
    id_token: string;
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
}

// ── Main ──────────────────────────────────────────────────
async function main(): Promise<void> {
  const { port } = parseArgs();
  const redirectUri = `http://localhost:${port}/callback`;

  console.log('Kakao Relay - CLI Login');
  console.log('======================\n');

  // Cognito login URL
  const loginUrl =
    `https://${COGNITO_DOMAIN}/login` +
    `?client_id=${encodeURIComponent(COGNITO_CLIENT_ID)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(OAUTH_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  // Start local server
  const server = http.createServer();
  let resolved = false;

  const loginPromise = new Promise<void>((resolve, reject) => {
    // Timeout
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        server.close();
        reject(new Error(`Login timed out after ${TIMEOUT_SEC} seconds.`));
      }
    }, TIMEOUT_SEC * 1000);

    server.on('request', async (req, res) => {
      if (resolved) {
        res.writeHead(200);
        res.end('Already processed.');
        return;
      }

      const reqUrl = new URL(req.url ?? '/', `http://localhost:${port}`);

      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = reqUrl.searchParams.get('code');
      const error = reqUrl.searchParams.get('error');

      if (error) {
        resolved = true;
        clearTimeout(timer);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(resultHtml(false, `Login error: ${error}`));
        server.close();
        reject(new Error(`Cognito error: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(resultHtml(false, 'No authorization code received.'));
        return;
      }

      try {
        console.log('Authorization code received. Exchanging for tokens...');

        const tokens = await exchangeCode(code, redirectUri);
        const expiresAt = Math.floor(Date.now() / 1000) + tokens.expires_in;

        await saveCredentials({
          id_token: tokens.id_token,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: expiresAt,
          relay_base_url: RELAY_BASE_URL,
        });

        resolved = true;
        clearTimeout(timer);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(resultHtml(true, 'Login successful! You can close this tab.'));

        console.log('\nLogin successful!');
        console.log(`Credentials saved to: ${getCredentialsPath()}`);
        console.log('\nYou can now use local-bridge with Cognito authentication.');

        server.close();
        resolve();
      } catch (err) {
        resolved = true;
        clearTimeout(timer);
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\nLogin failed: ${msg}`);

        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(resultHtml(false, 'Login failed. Please try again.'));

        server.close();
        reject(err);
      }
    });

    server.listen(port, () => {
      console.log(`Listening on http://localhost:${port}/callback`);
      console.log('Opening browser for login...\n');
      openBrowser(loginUrl);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use. Try --port <other-port>`);
      } else {
        console.error(`Server error: ${err.message}`);
      }
      clearTimeout(timer);
      reject(err);
    });
  });

  try {
    await loginPromise;
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}

function resultHtml(success: boolean, message: string): string {
  const color = success ? '#2e7d32' : '#c62828';
  const icon = success ? '&#10004;' : '&#10008;';
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Kakao Relay Login</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5;}
.card{background:white;border-radius:12px;padding:2rem;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.1);}
.icon{font-size:3rem;color:${color};}</style></head>
<body><div class="card"><div class="icon">${icon}</div><p>${message}</p></div></body></html>`;
}

main();
