import express from 'express';
import path from 'path';
import healthRouter from './routes/health';
import questionsRouter from './routes/questions';
import repliesRouter from './routes/replies';
import webhookRouter from './routes/webhook';
import kakaoAuthRouter from './routes/kakaoAuth';
import cognitoAuthRouter from './routes/cognitoAuth';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ── 환경변수 검증 ────────────────────────────────────────
if (!process.env.AUTH_TOKEN) {
  console.error('[FATAL] AUTH_TOKEN 환경변수가 설정되지 않았습니다.');
  process.exit(1);
}
if (!process.env.FIXED_USER_KEY) {
  console.warn('[WARN] FIXED_USER_KEY 환경변수가 설정되지 않았습니다. 카카오 웹훅이 모든 사용자를 거부합니다.');
}

// ── Cognito JWT 환경변수 확인 (Mode B, 선택적) ────────────
const cognitoVars = ['COGNITO_REGION', 'COGNITO_USER_POOL_ID', 'COGNITO_APP_CLIENT_ID'];
const cognitoConfigured = cognitoVars.every((v) => !!process.env[v]);
if (cognitoConfigured) {
  console.log('[relay-server] Cognito JWT auth enabled');
} else {
  const missing = cognitoVars.filter((v) => !process.env[v]);
  console.log(`[relay-server] Cognito JWT auth disabled (missing: ${missing.join(', ')})`);
}

// ── Kakao OAuth 환경변수 확인 (Mode B, 선택적) ────────────
const kakaoOAuthVars = ['KAKAO_CLIENT_ID', 'KAKAO_REDIRECT_URI'];
const kakaoOAuthConfigured = kakaoOAuthVars.every((v) => !!process.env[v]);
if (kakaoOAuthConfigured) {
  console.log('[relay-server] Kakao OAuth connect enabled');
} else {
  const missing = kakaoOAuthVars.filter((v) => !process.env[v]);
  console.log(`[relay-server] Kakao OAuth connect disabled (missing: ${missing.join(', ')})`);
}

// ── Cognito Self-Service 환경변수 확인 (선택적) ────────────
const cognitoSelfServiceVars = ['COGNITO_DOMAIN', 'COGNITO_APP_CLIENT_SECRET', 'CALLBACK_URL'];
const cognitoSelfServiceConfigured = cognitoSelfServiceVars.every((v) => !!process.env[v]);
if (cognitoSelfServiceConfigured) {
  console.log('[relay-server] Cognito self-service onboarding enabled');
} else {
  const missing = cognitoSelfServiceVars.filter((v) => !process.env[v]);
  console.log(`[relay-server] Cognito self-service onboarding disabled (missing: ${missing.join(', ')})`);
}

const app = express();

app.use(express.json());

// ── Routes ───────────────────────────────────────────────
app.use(healthRouter);
app.use(questionsRouter);
app.use(repliesRouter);
app.use(webhookRouter);
app.use(kakaoAuthRouter);
app.use(cognitoAuthRouter);

// ── Static files (Web Portal — 라우터 뒤에 배치) ────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Start ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[relay-server] listening on port ${PORT}`);
  // 민감정보(AUTH_TOKEN) 출력 금지
  console.log(`[relay-server] FIXED_USER_KEY configured: ${process.env.FIXED_USER_KEY ? 'yes' : 'no'}`);
});

export default app;
