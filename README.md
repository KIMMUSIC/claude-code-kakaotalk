# Claude Code KakaoTalk Bridge

Claude Code에서 카카오톡으로 사용자에게 질문하고 답변을 받을 수 있는 HITL(Human-In-The-Loop) 브리지입니다.

## 개요

AI(Claude Code)가 작업 중 사용자 확인이 필요할 때, 카카오톡으로 직접 질문을 보내고 답변을 받을 수 있습니다.

### 주요 기능

- Claude Code에서 카카오톡으로 질문 전송
- 카카오톡에서 바로 답변 (선택지/자유입력)
- "나에게 보내기"로 실시간 알림
- MCP(Model Context Protocol) 기반 Claude Code 연동

## 아키텍처

```
┌─────────────┐     MCP/stdio      ┌──────────────┐     HTTPS      ┌──────────────┐
│ Claude Code  │ ◄────────────────► │ Local Bridge │ ◄────────────► │ Relay Server │
│  (AI Agent)  │                    │  (MCP Server)│                │  (AWS ECS)   │
└─────────────┘                    └──────────────┘                └──────┬───────┘
                                                                          │
                                                          ┌───────────────┼───────────────┐
                                                          │               │               │
                                                    ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
                                                    │  Cognito   │  │  DynamoDB  │  │   Kakao   │
                                                    │ (인증/JWT) │  │ (토큰저장) │  │ (챗봇API) │
                                                    └───────────┘  └───────────┘  └───────────┘
```

### 구성 요소

| 구성 요소 | 설명 |
|-----------|------|
| **Local Bridge** | 사용자 PC에서 실행되는 MCP 서버. Claude Code와 Relay 사이 브리지 |
| **Relay Server** | AWS ECS에서 실행되는 공용 서버. 카카오 웹훅 수신 + API 제공 |
| **Web Portal** | 회원가입, 카카오 연동, 설정 안내를 위한 웹 페이지 |

## 사용자 가이드 (Quick Start)

### 사전 요구사항

- **Node.js** 18 이상
- **Git**
- **카카오톡** 계정

### Step 1: 회원가입 및 카카오 연동

1. [서비스 페이지](https://vintagelane.store)에 접속합니다.
2. **"시작하기"** 버튼을 클릭하여 회원가입/로그인합니다.
3. 대시보드에서 **"카카오 연동하기"** 버튼을 클릭합니다.
4. 카카오 계정으로 로그인하고 권한을 허용합니다.

### Step 2: Local Bridge 설치

```bash
git clone https://github.com/KIMMUSIC/claude-code-kakaotalk.git
cd claude-code-kakaotalk/local-bridge
npm install
npm run build
```

### Step 3: CLI 로그인

Local Bridge 디렉토리에서 로그인 명령을 실행합니다. 브라우저가 열리면 Step 1에서 만든 계정으로 로그인하세요.

```bash
node dist/login.js
```

성공하면 `~/.kakao-relay/credentials.json`에 인증 정보가 저장됩니다.

### Step 4: Claude Code MCP 설정

Claude Code 프로젝트의 `.claude/mcp.json` 파일에 아래 내용을 추가합니다.

```json
{
  "mcpServers": {
    "kakao-local-bridge": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "<설치경로>/claude-code-kakaotalk/local-bridge",
      "env": {
        "TARGET_USER_ID": "<your-user-id>"
      }
    }
  }
}
```

- `<설치경로>`: Step 2에서 clone한 절대 경로 (예: `/home/user`, `C:\\Users\\user`)
- `<your-user-id>`: 대시보드에서 확인할 수 있는 User ID

### Step 5: 테스트

1. Claude Code를 재시작합니다.
2. Claude에게 "카카오톡으로 사용자에게 확인해줘"라고 요청합니다.
3. 카카오톡에서 질문을 확인하고 답변합니다.

## 동작 흐름

```
1. Claude Code가 사용자 확인이 필요한 상황 발생
2. MCP 프로토콜로 Local Bridge의 kakao.ask_user 호출
3. Local Bridge가 Relay Server에 질문 POST
4. Relay Server가 세션에 질문 저장 + (선택) 카카오톡 알림 발송
5. 사용자가 카카오톡 챗봇에서 답변 입력
6. 카카오 챗봇이 Relay Server 웹훅으로 답변 전달
7. Local Bridge가 Long Polling으로 답변 수신
8. Claude Code가 답변을 받아 작업 계속
```

## MCP 도구

### `kakao.ask_user`

카카오톡으로 사용자에게 질문을 보내고 답변을 기다립니다.

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| `session_id` | string | Y | UUID v4 세션 식별자 |
| `text` | string | Y | 질문 텍스트 |
| `choices` | string[] | N | 미리 정의된 선택지 |
| `timeout_sec` | number | N | 타임아웃 (기본: 120초) |
| `severity` | string | N | 심각도: INFO, WARNING, DANGER |

**응답 상태:**
- `RESOLVED`: 사용자가 답변함
- `EXPIRED`: 타임아웃
- `ERROR`: 오류 발생

### `kakao.notify_user`

사용자에게 알림을 보냅니다 (현재는 로그 출력만).

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| `session_id` | string | Y | UUID v4 세션 식별자 |
| `text` | string | Y | 알림 텍스트 |
| `severity` | string | N | 심각도: INFO, WARNING, DANGER |

## 인증 방식

### CLI 로그인 (권장)

`node dist/login.js` 실행 시 브라우저가 열리고 Cognito Hosted UI에서 로그인합니다.
인증 정보는 `~/.kakao-relay/credentials.json`에 저장되며, Local Bridge 시작 시 자동으로 로드됩니다.
토큰이 만료되면 자동으로 갱신됩니다.

### 환경변수 (대체)

CLI 로그인을 사용하지 않는 경우, 환경변수로 인증할 수 있습니다:

| 환경변수 | 설명 |
|----------|------|
| `COGNITO_ID_TOKEN` | Cognito ID Token |
| `COGNITO_ACCESS_TOKEN` | Cognito Access Token |
| `AUTH_TOKEN` | 정적 인증 토큰 (단일 사용자 모드) |

## 프로젝트 구조

```
claude-code-kakaotalk/
├── relay-server/           # Relay Server (AWS ECS에서 실행)
│   ├── src/
│   │   ├── index.ts        # Express 서버 진입점
│   │   ├── routes/
│   │   │   ├── health.ts       # GET /healthz
│   │   │   ├── questions.ts    # POST /v1/sessions/:id/questions
│   │   │   ├── replies.ts      # GET /v1/sessions/:id/replies
│   │   │   ├── webhook.ts      # POST /webhook/kakao
│   │   │   ├── kakaoAuth.ts    # Kakao OAuth 연동
│   │   │   └── cognitoAuth.ts  # Cognito 인증 엔드포인트
│   │   ├── middleware/
│   │   │   └── auth.ts         # JWT/Token 인증 미들웨어
│   │   ├── services/
│   │   │   └── tokenVault.ts   # DynamoDB 토큰 저장소
│   │   └── outbound/
│   │       └── kakaoSender.ts  # 카카오 메시지 발송
│   ├── public/
│   │   ├── index.html          # 랜딩 페이지
│   │   └── dashboard.html      # 대시보드 SPA
│   ├── Dockerfile
│   └── package.json
├── local-bridge/           # Local Bridge (사용자 PC에서 실행)
│   ├── src/
│   │   ├── index.ts        # MCP 서버 진입점
│   │   ├── credentials.ts  # 인증 정보 관리
│   │   └── login.ts        # CLI 로그인 도구
│   ├── package.json
│   └── tsconfig.json
├── contracts.md            # API 계약 문서
└── README.md
```

## Relay Server 자체 호스팅

자체 Relay Server를 운영하려면 아래 AWS 리소스가 필요합니다:

### 필요 AWS 리소스

- **ECS Fargate** (또는 EC2): Relay Server 실행
- **ALB**: HTTPS 로드밸런서
- **ACM**: SSL 인증서
- **Cognito User Pool**: 사용자 인증
- **DynamoDB**: 카카오 토큰 저장 (`kakao-relay-tokens` 테이블)
- **KMS**: 토큰 암호화 키
- **ECR**: Docker 이미지 저장소

### 필요 환경변수

| 변수 | 필수 | 설명 |
|------|------|------|
| `PORT` | N | 서버 포트 (기본: 3000) |
| `AUTH_TOKEN` | Y | 정적 인증 토큰 (Mode A) |
| `FIXED_USER_KEY` | Y | 카카오 웹훅 허용 사용자 키 (Mode A) |
| `COGNITO_REGION` | Y* | Cognito 리전 |
| `COGNITO_USER_POOL_ID` | Y* | User Pool ID |
| `COGNITO_APP_CLIENT_ID` | Y* | App Client ID |
| `COGNITO_DOMAIN` | Y* | Cognito Hosted UI 도메인 |
| `COGNITO_APP_CLIENT_SECRET` | Y* | App Client Secret |
| `CALLBACK_URL` | Y* | OAuth callback URL |
| `KAKAO_CLIENT_ID` | Y* | Kakao REST API 키 |
| `KAKAO_CLIENT_SECRET` | N | Kakao Client Secret |
| `KAKAO_REDIRECT_URI` | Y* | Kakao OAuth callback URL |
| `DDB_TABLE_KAKAO_TOKENS` | Y* | DynamoDB 테이블명 |
| `KMS_KEY_ID` | Y* | KMS 암호화 키 ID |

> *Y*: SaaS 모드(Mode B) 사용 시 필수

### Docker 빌드

```bash
cd relay-server
docker build -t kakao-relay-server .
```

### 카카오 챗봇 설정

1. [카카오 i 오픈빌더](https://i.kakao.com/)에서 챗봇을 생성합니다.
2. 스킬(Skill)에 웹훅 URL을 등록합니다: `https://<your-domain>/webhook/kakao`
3. 시나리오에서 폴백 블록에 해당 스킬을 연결합니다.

## 트러블슈팅

### "NETWORK_ERROR: fetch failed" 오류

- `~/.kakao-relay/credentials.json` 파일이 존재하는지 확인하세요.
- `node dist/login.js`로 다시 로그인해보세요.
- Relay Server가 정상 동작하는지 확인: `curl https://vintagelane.store/healthz`

### "UNAUTHORIZED" 오류

- 토큰이 만료되었을 수 있습니다. `node dist/login.js`로 다시 로그인하세요.
- `credentials.json`의 `relay_base_url`이 올바른지 확인하세요.

### "PENDING_EXISTS" 오류

- 이미 대기 중인 질문이 있습니다. 카카오톡에서 먼저 답변하세요.

### 카카오톡에서 답변했는데 응답이 안 오는 경우

1. 카카오 챗봇 관리센터에서 웹훅 URL이 올바른지 확인하세요.
2. 카카오 연동이 완료되었는지 대시보드에서 확인하세요.
3. Relay Server 로그를 확인하세요.

### Claude Code에서 MCP 도구가 안 보이는 경우

1. `.claude/mcp.json` 파일 경로와 내용이 올바른지 확인하세요.
2. `cwd` 경로가 local-bridge 디렉토리를 가리키는지 확인하세요.
3. Claude Code를 완전히 종료 후 재시작하세요.

## 라이선스

MIT
