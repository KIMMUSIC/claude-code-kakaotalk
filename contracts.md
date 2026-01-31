# contracts.md — Kakao ↔ Relay ↔ Local Bridge API Contract (MVP + SaaS 확장 포함)

> 본 문서는 **(A) 현재 구현 기반 MVP 단일 사용자 모드**와  
> **(B) SaaS 멀티유저 모드(Cognito + target_user_id + AWS 토큰 저장 + Kakao “나에게 보내기” Push)**  
> 를 “모드별 계약”으로 함께 고정한다.
>
> - **A 모드**: 지금 돌아가는 시스템(고정 동작) — 변경 시 버전업 필요
> - **B 모드**: 앞으로 구현할 SaaS 목표 계약 — 구현 완료 시 A의 단일 사용자 가정 제거

---

## 0) 용어/구성

- **Local Bridge**: Claude Code와 붙는 로컬 MCP 서버(브리지)
- **Relay**: Public Relay/Skill Server (카카오 웹훅 수신 + 로컬 브리지용 API 제공)
- **Kakao Skill Webhook**: 카카오 챗봇(오픈빌더 스킬)이 Relay로 보내는 인바운드 요청
- **Mode A (MVP Single-User)**: AUTH_TOKEN + FIXED_USER_KEY 기반 단일 사용자 운영
- **Mode B (SaaS Multi-User)**: Cognito JWT + 사용자별 Kakao OAuth 토큰 기반 멀티유저 운영

---

## 1) 공통 결정 사항(고정)

### D-1) session_id 형식
- **UUID v4** (path 파라미터)
- 예: `550e8400-e29b-41d4-a716-446655440000`

### D-2) 질문 중복 처리(pending_question 존재 시)
- 동일 `session_id`에 대해 `POST /questions`가 들어왔는데 이미 `pending_question`이 존재하는 경우
- **409 Conflict 반환 (기존 pending_question 유지)**

```json
{
  "error": "PENDING_EXISTS",
  "message": "A pending question already exists for this session."
}
```

### D-3) 없는 세션 처리(session 미존재 시)
- `POST /questions` 또는 `GET /replies` 호출 시 Relay에 `session_id`가 없는 경우
- **자동 생성**
  - `POST /questions`: 세션 생성 + 상태 `WAITING_USER`
  - `GET /replies`: 세션 생성 + 상태 `IDLE`, `replies: []`

---

## 2) 상태/모델

### 2.1 Status Enum
- `IDLE`         : 대기 질문 없음
- `WAITING_USER` : 질문 발송됨, 사용자 응답 대기
- `RESOLVED`     : 사용자 응답 수신 완료
- `EXPIRED`      : 질문 타임아웃(서버 TTL/timeout 처리 시 사용)
- `CANCELED`     : 사용자 취소/세션 종료

### 2.2 ReplyType Enum
- `TEXT` | `CHOICE` | `CANCEL`

---

## 3) 인증/보안

### 3.1 Mode A (MVP Single-User): AUTH_TOKEN
- Header: `Authorization: Bearer <AUTH_TOKEN>`
- Relay는 환경변수 `AUTH_TOKEN`과 단순 비교로 검증
- 실패: `401 Unauthorized`

```json
{
  "error": "UNAUTHORIZED",
  "message": "Missing or invalid Authorization header."
}
```

### 3.2 Mode B (SaaS Multi-User): Cognito JWT
- Header: `Authorization: Bearer <COGNITO_JWT>`
- Relay는 Cognito JWKS로 서명 검증 + `iss/aud/exp` 검증
- 성공 시:
  - `caller_user_id = token.sub` (이 값이 SaaS에서의 사용자 ID)
- 실패: `401 Unauthorized`

### 3.3 로그 보안(공통)
- `AUTH_TOKEN`, OAuth secret, access_token/refresh_token, 민감 키들은 **로그에 절대 출력 금지**
- 에러 로그는 원칙적으로 `err.message` 수준으로 제한

---

## 4) 환경변수

### 4.1 Mode A (MVP Single-User)
| 변수 | 필수 | 설명 |
|------|------|------|
| `PORT` | N | 서버 포트(기본 3000) |
| `AUTH_TOKEN` | **Y** | Local Bridge → Relay 인증 Bearer 토큰 |
| `FIXED_USER_KEY` | **Y** | 카카오 웹훅에서 허용할 사용자 키(단일 사용자 고정) |

### 4.2 Mode B (SaaS Multi-User)

#### (1) Auth (Cognito)
| 변수 | 필수 | 설명 |
|------|------|------|
| `COGNITO_REGION` | **Y** | Cognito 리전 |
| `COGNITO_USER_POOL_ID` | **Y** | User Pool ID |
| `COGNITO_APP_CLIENT_ID` | **Y** | App Client ID |

#### (2) Kakao OAuth (사용자 연동: talk_message 동의)
| 변수 | 필수 | 설명 |
|------|------|------|
| `KAKAO_CLIENT_ID` | **Y** | Kakao Dev 앱 REST API 키 |
| `KAKAO_CLIENT_SECRET` | N | 설정한 경우 사용 |
| `KAKAO_REDIRECT_URI` | **Y** | OAuth callback URL |
| `KAKAO_OAUTH_SCOPES` | **Y** | 예: `talk_message` |

#### (3) Token Vault (AWS)
| 변수 | 필수 | 설명 |
|------|------|------|
| `DDB_TABLE_KAKAO_TOKENS` | **Y** | DynamoDB 테이블명 |
| `KMS_KEY_ID` | **Y** | 토큰 암복호화용 KMS Key |

#### (4) Outbound Sender (선알림)
| 변수 | 필수 | 설명 |
|------|------|------|
| `KAKAO_PROVIDER` | N | `noop` / `bizmessage` / `kakao_memo` |
| `KAKAO_PROVIDER_MODE` | N | `LIVE` / `MOCK` (선택) |

---

## 5) API — Local Bridge ↔ Relay (공통 + SaaS 확장)

### 5.1 Create Question
`POST /v1/sessions/{session_id}/questions`

#### Auth
- Mode A: `Authorization: Bearer <AUTH_TOKEN>`
- Mode B: `Authorization: Bearer <COGNITO_JWT>`

#### Request JSON (Mode A)
```json
{
  "text": "string",
  "choices": ["string"],
  "timeout_sec": 300,
  "severity": "INFO | WARNING | DANGER",
  "metadata": {
    "source": "claude_code",
    "action_hint": "optional"
  }
}
```

#### Request JSON (Mode B 추가)
Mode B에서는 **수신자 지정**을 위해 `target_user_id`가 필수다.
```json
{
  "target_user_id": "cognito-sub-string",
  "text": "string",
  "choices": ["string"],
  "timeout_sec": 300,
  "severity": "INFO | WARNING | DANGER",
  "metadata": {
    "source": "claude_code",
    "action_hint": "optional"
  }
}
```

#### Authorization Rule (Mode B / MVP 안전 규칙)
- (초기 SaaS MVP) **caller_user_id(sub) != target_user_id 이면 403**
- 향후 admin/role로 확장 가능(TODO)

403 예시:
```json
{
  "error": "FORBIDDEN",
  "message": "caller_user_id must match target_user_id in MVP."
}
```

#### Success Response
- **HTTP 201 Created**
```json
{
  "session_id": "uuid-v4",
  "message_id": "string",
  "status": "WAITING_USER"
}
```

#### Errors
- `401` 인증 실패
- `403` (Mode B) target_user_id 권한 위반
- `409` pending 존재(D-2)
- `400` 입력 오류

#### Behavior (공통)
- 세션이 없으면 자동 생성(D-3)
- 성공 시:
  - 세션 상태 `WAITING_USER`
  - `pending_question` 저장
  - `message_id` 발급

#### Outbound Push (선알림) — 옵션 기능
- 질문 등록(201) 이후 **fire-and-forget**으로 Outbound Sender 실행
- Sender 실패/비활성이라도 API 201은 유지
- Sender 선택:
  - `KAKAO_PROVIDER` 미설정/`noop`: 로그만 남기고 발송 안 함
  - `bizmessage`: (유료/계약 필요) 알림톡 발송
  - `kakao_memo`: (무료/사용자 동의 필요) “나에게 보내기” 발송

---

### 5.2 Poll Replies (Long Poll)
`GET /v1/sessions/{session_id}/replies?since=<reply_id_optional>&wait_sec=25`

#### Auth
- Mode A: `Authorization: Bearer <AUTH_TOKEN>`
- Mode B: `Authorization: Bearer <COGNITO_JWT>`

#### Query
- `since` (optional): 해당 reply_id 이후만 반환
- `wait_sec` (optional): 대기 시간(초)
  - 최대 60초 권장

#### Response JSON
```json
{
  "session_id": "uuid-v4",
  "status": "IDLE | WAITING_USER | RESOLVED | EXPIRED | CANCELED",
  "replies": [
    {
      "reply_id": "string",
      "type": "TEXT | CHOICE | CANCEL",
      "text": "string",
      "choice": "string",
      "created_at": "RFC3339 string"
    }
  ]
}
```

#### Behavior
- 세션이 없으면 자동 생성(D-3)
  - 생성 직후 `IDLE`, `replies: []`
- `wait_sec` 동안 새 reply 없으면 `replies: []`로 200 반환
- reply가 추가되면 즉시 반환
- `WAITING_USER`에서 reply가 추가되면 상태를 `RESOLVED`로 전환(최소 규칙)

---

### 5.3 Health
`GET /healthz`
```json
{ "ok": true }
```

---

## 6) API — SaaS: Kakao OAuth Connect (Mode B)

> 목적: 사용자가 “무료 선알림(나에게 보내기)”을 받기 위해 **카카오 계정 연동 + talk_message 동의**를 수행한다.

### 6.1 Start OAuth
`GET /auth/kakao/start`

- Auth: **Cognito JWT 필수**
- 동작:
  - Relay가 `state`를 생성(서명 또는 서버 저장)
  - Kakao authorize URL로 302 redirect

### 6.2 OAuth Callback
`GET /auth/kakao/callback?code=...&state=...`

- Auth: 권장(콜백 자체는 public로 두고 state로 user_id를 검증해도 됨. 구현 선택)
- 동작:
  - code → access_token/refresh_token 발급
  - `expires_at` 계산
  - Token Vault에 저장(암호화 필수)
  - 가능하면 `kakao_user_key`(채널 webhook에서 들어오는 user key)도 함께 저장

### 6.3 Token Vault 저장 규칙(Mode B)
- 저장소: AWS DynamoDB (`DDB_TABLE_KAKAO_TOKENS`)
- 파티션 키: `user_id` (= Cognito sub)
- 저장 필드(예시):
  - `kakao_access_token_enc` (KMS로 암호화)
  - `kakao_refresh_token_enc` (KMS로 암호화)
  - `expires_at` (epoch seconds)
  - `scope`
  - `kakao_user_key` (string)  ← webhook 매핑의 핵심
  - `updated_at`

> 최소 요구: refresh token 기반 갱신이 가능해야 하며, 토큰/시크릿은 로그에 노출되면 안 된다.

---

## 7) Kakao Webhook → Relay

### 7.1 입력 Payload (현재 가정 + fallback)
```json
{
  "userRequest": {
    "user": { "id": "<kakao_user_key>" },
    "utterance": "<사용자 입력 텍스트>"
  }
}
```

- `kakao_user_key` = `body.userRequest.user.id`
- `user_text`      = `body.userRequest.utterance`

Fallback(테스트):
- `kakao_user_key` = `body.user_key`
- `user_text`      = `body.text`

---

### 7.2 Mode A (MVP Single-User) — 고정 동작
- ENV: `FIXED_USER_KEY`
- `kakao_user_key != FIXED_USER_KEY`:
  - HTTP 200
  - reply 저장 안 함
  - `"허용되지 않은 사용자입니다."`
- `kakao_user_key == FIXED_USER_KEY`:
  - **현재 WAITING_USER인 세션 중 “가장 최근” 1개**를 선택하여 reply 적재
  - WAITING 세션이 없으면 `"현재 대기 중인 질문이 없습니다."`

---

### 7.3 Mode B (SaaS Multi-User) — 목표 동작(확장 계약)
Mode B에서는 단일 사용자 필터링 대신 **kakao_user_key → user_id 매핑**이 필요하다.

#### 7.3.1 사용자 매핑
- 입력: `kakao_user_key`
- 조회: Token Vault(DynamoDB)에서 `kakao_user_key`로 `user_id`를 찾는다.
  - 권장: `kakao_user_key`를 Partition Key로 하는 GSI 운영
- 매핑 실패 시:
  - HTTP 200
  - 응답 텍스트: `"연동되지 않은 사용자입니다. 먼저 연동을 완료해주세요."`
  - reply 저장 안 함

#### 7.3.2 세션 선택 규칙(중요)
- 매핑된 `user_id`에 대해서만 세션을 선택한다.
- 선택 대상: `owner_user_id == user_id` AND `status == WAITING_USER`
- 선택 로직: “가장 최근 WAITING_USER 세션 1개”
- 없으면:
  - HTTP 200
  - `"현재 대기 중인 질문이 없습니다."`

> Mode A의 “전역 가장 최근 WAITING” 규칙은 SaaS에서 **반드시 사용자 스코프**로 제한한다.

---

### 7.4 reply 타입 결정(공통)
- pending_question에 `choices`가 있고,
- 사용자 입력(`user_text`)이 choices 중 하나와 **대소문자 무시 비교로 일치**하면:
  - `type = "CHOICE"`, `choice = matchedChoice`
- 아니면:
  - `type = "TEXT"`

---

### 7.5 카카오 응답 형식(공통)
기본 성공 응답:
```json
{
  "version": "2.0",
  "template": {
    "outputs": [
      { "simpleText": { "text": "응답을 접수했습니다." } }
    ]
  }
}
```

(질문 조회 모드/quickReplies는 구현에 따라 추가 가능)

---

## 8) TTL / 타임아웃 정책
- session TTL: 24h (권장, 구현 TODO)
- pending_question TTL: `timeout_sec` 기반으로 `EXPIRED` 처리 (권장, 구현 TODO)
- reply TTL: 24h (권장, 구현 TODO)

---

## 9) 에러 규칙(최소)
- 인증 실패: `401`
- 권한 위반(Mode B): `403`
- 입력 오류: `400`
- 중복 질문 충돌: `409` (D-2)
- 세션 미존재: 에러가 아니라 자동 생성으로 흡수 (D-3)

---

## 10) 마이그레이션 메모 (A → B)
- B가 적용되면:
  - `FIXED_USER_KEY` 기반 단일 사용자 제한은 제거(또는 개발용 fallback으로만 유지)
  - webhook 세션 매핑은 반드시 `kakao_user_key → user_id` 기반으로 전환
  - `POST /questions`는 `target_user_id`를 요구(멀티유저 라우팅)
  - Local Bridge는 Cognito JWT를 들고 Relay에 호출(또는 서버-서버 토큰 전략 추가)

---

## 11) Self-Service Onboarding (Mode B)

> 목적: 사용자가 AWS CLI 없이 직접 회원가입, 카카오 연동, local-bridge 설정을 완료할 수 있는 Self-Service 온보딩 플로우.

### 11.1 Web Portal Flow

```
User → index.html → Cognito Hosted UI (signup/login)
     → /auth/callback?code=... → relay가 code→token 교환
     → HTML이 sessionStorage에 토큰 저장 → /dashboard.html 리다이렉트
     → dashboard.html JS가 /auth/me 호출 → 상태 표시
     → "카카오 연동" → /auth/kakao/start-url → Kakao OAuth → DDB 저장
```

- 정적 페이지: `public/index.html` (랜딩), `public/dashboard.html` (대시보드 SPA)
- 토큰 저장: `sessionStorage` (탭 닫으면 자동 삭제, URL 히스토리에 노출 방지)
- 프레임워크: Vanilla HTML+JS (빌드 스텝 불필요)

### 11.2 Cognito Token Endpoints

Relay가 Cognito `client_secret`을 서버사이드에서만 보유하여 브라우저/CLI에 노출하지 않는다.

#### 11.2.1 `GET /auth/callback?code=...` (public)
- Cognito authorization code → token 교환 (서버사이드)
- 응답: HTML 페이지가 `sessionStorage`에 토큰 저장 후 `/dashboard.html` 리다이렉트
- `client_secret`은 서버에서만 사용

#### 11.2.2 `POST /auth/token` (public)
- CLI용 code 교환
- Request Body: `{ "code": "string", "redirect_uri": "string" }`
- Relay가 `client_secret`으로 Cognito token endpoint 호출
- 응답 200:
```json
{
  "id_token": "string",
  "access_token": "string",
  "refresh_token": "string",
  "expires_in": 3600
}
```

#### 11.2.3 `POST /auth/refresh` (public)
- 토큰 갱신 프록시
- Request Body: `{ "refresh_token": "string" }`
- `client_secret` 서버사이드 유지
- 응답 200:
```json
{
  "id_token": "string",
  "access_token": "string",
  "expires_in": 3600
}
```

#### 11.2.4 `GET /auth/me` (requireAuth)
- 사용자 정보 + 카카오 연동 상태
- Token Vault에서 `user_id`로 카카오 연동 여부 확인
- 응답 200:
```json
{
  "user_id": "cognito-sub",
  "auth_method": "cognito_jwt",
  "kakao": {
    "connected": true,
    "kakao_user_key": "string|null",
    "scope": "talk_message|null"
  }
}
```

#### 11.2.5 `GET /auth/logout` (public)
- 302 → Cognito Hosted UI logout URL
- `logout_uri`: 환경변수 `LOGOUT_URL` (기본: `https://vintagelane.store/`)

### 11.3 Kakao Connect (Web Portal용)

#### `GET /auth/kakao/start-url` (requireAuth)
- 기존 `/auth/kakao/start` (redirect 방식)과 달리 JSON으로 authorize URL 반환
- 대시보드 JS가 `fetch()`로 호출 (Authorization 헤더 포함 가능)
- 응답 200:
```json
{
  "authorize_url": "https://kauth.kakao.com/oauth/authorize?..."
}
```
- state에 `return_to` 필드 추가 → callback 후 대시보드로 리다이렉트

### 11.4 CLI Login

```
kakao-relay-login 실행
  → 브라우저 열기 → Cognito Hosted UI (redirect_uri=http://localhost:19281/callback)
  → localhost 임시서버가 code 수신
  → POST /auth/token으로 code→token 교환 (client_secret은 서버에만)
  → ~/.kakao-relay/credentials.json에 저장
```

- 포트: `19281` (기본값, `--port`로 변경 가능)
- 타임아웃: 120초
- 자격증명 파일: `~/.kakao-relay/credentials.json`
  - 디렉토리 권한: `0700`
  - 파일 권한: `0600`

### 11.5 Local Bridge Auto-Auth

```
startup:
  1. ~/.kakao-relay/credentials.json 로드 시도
  2. 유효하면 → id_token 사용
  3. 만료되었으면 → POST /auth/refresh → 갱신 → 저장
  4. 파일 없으면 → env vars fallback (COGNITO_ID_TOKEN / AUTH_TOKEN)
```

- 401 수신 시 자동 갱신 + 재시도 (1회)
- 갱신 성공 시 credentials.json 업데이트

### 11.6 환경변수 (Self-Service Onboarding 추가)

| 변수 | 필수 | 설명 |
|------|------|------|
| `COGNITO_DOMAIN` | **Y** | Cognito Hosted UI 도메인 (e.g. `kakao-relay.auth.ap-northeast-2.amazoncognito.com`) |
| `COGNITO_APP_CLIENT_SECRET` | **Y** | App Client Secret (서버사이드 전용) |
| `CALLBACK_URL` | **Y** | 웹 포털 OAuth callback URL (e.g. `https://vintagelane.store/auth/callback`) |
| `LOGOUT_URL` | N | 로그아웃 후 리다이렉트 URL (기본: `/`) |
