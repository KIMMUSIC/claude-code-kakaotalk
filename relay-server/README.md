# Kakao Relay Server (MVP)

카카오톡 ↔ Claude Code HITL(Human-in-the-Loop) 브리지의 Public Relay/Skill 서버.

## 환경변수

| 변수 | 필수 | 설명 |
|------|------|------|
| `PORT` | N | 서버 포트 (기본 3000) |
| `AUTH_TOKEN` | **Y** | Local Bridge → Relay 인증용 Bearer 토큰 |
| `FIXED_USER_KEY` | **Y** | 카카오 웹훅에서 허용할 사용자 키 (MVP 고정 매핑) |
| `KAKAO_PROVIDER` | N | Push sender 프로바이더 (`bizmessage`). 미설정 시 sender 비활성 |
| `KAKAO_OAUTH_CLIENT_ID` | N | BizMessage OAuth client ID |
| `KAKAO_OAUTH_SECRET` | N | BizMessage OAuth secret |
| `KAKAO_BASE_URL` | N | BizMessage API 호스트 (기본: `bizmsg-web.kakaoenterprise.com`) |
| `KAKAO_SENDER_KEY` | N | 발신 프로필 키 |
| `KAKAO_TEMPLATE_CODE` | N | 알림톡 템플릿 코드 |
| `KAKAO_SENDER_NO` | N | 발신 번호 (SMS fallback용) |
| `KAKAO_PHONE_NUMBER` | N | 수신자 전화번호 (MVP: 단일 수신자) |
| `MOCK_BIZMESSAGE` | N | `1`로 설정 시 실제 HTTP 호출 없이 MOCK 발송 |

> **주의**: `AUTH_TOKEN`은 로그에 절대 출력되지 않습니다.

### Push Sender (Outbound)

질문 등록(201) 시 카카오톡으로 알림톡을 자동 발송하는 기능입니다.
**BizMessage 연동이 필요**하며, MVP에서는 `KAKAO_PROVIDER` 미설정 시 no-op(로그만 출력)으로 동작합니다.

설정 순서:
1. 카카오 비즈니스 채널에서 BizMessage 발신 프로필 생성
2. OAuth 인증 정보 발급 (`KAKAO_OAUTH_CLIENT_ID`, `KAKAO_OAUTH_SECRET`)
3. 알림톡 템플릿 등록 후 `KAKAO_TEMPLATE_CODE` 설정
4. `KAKAO_PROVIDER=bizmessage`로 sender 활성화

#### MOCK 모드로 테스트

실제 BizMessage 계약 없이 sender 동작을 검증할 수 있습니다:

```bash
KAKAO_PROVIDER=bizmessage MOCK_BIZMESSAGE=1 \
  PORT=3000 AUTH_TOKEN=my-secret FIXED_USER_KEY=user123 npm start
```

질문 등록 시 서버 로그에 `[sender_ok] MOCK session=... cid=...`가 출력되면 정상입니다.

#### 실제 발송 모드

BizMessage 계약/키/템플릿/발신프로필이 모두 준비된 후:

```bash
KAKAO_PROVIDER=bizmessage \
  KAKAO_OAUTH_CLIENT_ID=<id> KAKAO_OAUTH_SECRET=<secret> \
  KAKAO_SENDER_KEY=<key> KAKAO_TEMPLATE_CODE=<code> \
  KAKAO_SENDER_NO=<number> KAKAO_PHONE_NUMBER=<receiver> \
  PORT=3000 AUTH_TOKEN=my-secret FIXED_USER_KEY=user123 npm start
```

> **주의**: 스테이징 환경에서도 실제 알림톡이 발송될 수 있습니다.

## 실행

```bash
cd relay-server
npm install
npm run build
# 환경변수 설정 후 실행
PORT=3000 AUTH_TOKEN=my-secret FIXED_USER_KEY=kakao-user-123 npm start
```

개발 모드 (ts-node):
```bash
PORT=3000 AUTH_TOKEN=my-secret FIXED_USER_KEY=kakao-user-123 npm run dev
```

## 파일 구조

```
src/
├── index.ts              # Express 앱 진입점, 라우터 등록
├── types.ts              # Session, PendingQuestion, Reply 타입 정의
├── store.ts              # 인메모리 세션 저장소 (Map 기반)
├── middleware/
│   └── auth.ts           # Bearer token 인증 미들웨어
├── outbound/
│   └── kakaoSender.ts    # BizMessage 알림톡 발송 (+ No-op / Mock 모드)
└── routes/
    ├── health.ts         # GET /healthz
    ├── questions.ts      # POST /v1/sessions/:session_id/questions
    ├── replies.ts        # GET /v1/sessions/:session_id/replies
    └── webhook.ts        # POST /webhook/kakao
```

## API 테스트 (curl)

### 1. Health Check

```bash
curl http://localhost:3000/healthz
# → {"ok":true}
```

### 2. 질문 등록

```bash
curl -X POST http://localhost:3000/v1/sessions/550e8400-e29b-41d4-a716-446655440000/questions \
  -H "Authorization: Bearer my-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "main 브랜치에 push 하시겠습니까?",
    "choices": ["예", "아니오"],
    "severity": "WARNING",
    "timeout_sec": 120
  }'
# → {"session_id":"550e8400-...","message_id":"...","status":"WAITING_USER"}
```

### 3. 중복 질문 시 409

```bash
curl -X POST http://localhost:3000/v1/sessions/550e8400-e29b-41d4-a716-446655440000/questions \
  -H "Authorization: Bearer my-secret" \
  -H "Content-Type: application/json" \
  -d '{"text": "두 번째 질문", "severity": "INFO"}'
# → 409 {"error":"PENDING_EXISTS","message":"A pending question already exists for this session."}
```

### 4. 카카오 웹훅

`/webhook/kakao`는 **질문 조회 모드**와 **답변 모드** 두 가지를 지원합니다.

#### 4-1. 질문 조회 모드

`pending`, `질문`, `?` 중 하나를 입력하면 현재 대기 중인 질문을 표시합니다.
choices가 있으면 quickReplies 버튼이 함께 제공됩니다.

```bash
curl -X POST http://localhost:3000/webhook/kakao \
  -H "Content-Type: application/json" \
  -d '{
    "userRequest": {
      "user": { "id": "kakao-user-123" },
      "utterance": "pending"
    }
  }'
# → {"version":"2.0","template":{"outputs":[{"simpleText":{"text":"main 브랜치에 push 하시겠습니까?"}}],"quickReplies":[{"label":"예","action":"message","messageText":"예"},{"label":"아니오","action":"message","messageText":"아니오"}]}}
```

#### 4-2. 답변 모드 (응답 전송)

질문 조회 키워드가 아닌 텍스트를 보내면 답변으로 처리됩니다.
quickReply 버튼 클릭 시에도 해당 텍스트가 답변으로 접수됩니다.

```bash
curl -X POST http://localhost:3000/webhook/kakao \
  -H "Content-Type: application/json" \
  -d '{
    "userRequest": {
      "user": { "id": "kakao-user-123" },
      "utterance": "예"
    }
  }'
# → {"version":"2.0","template":{"outputs":[{"simpleText":{"text":"응답을 접수했습니다."}}]}}
```

#### 카카오톡 사용 흐름 예시

1. 카카오톡에서 `pending` 입력 → 대기 중인 질문과 선택지 버튼 표시
2. quickReply `예` 클릭 → 답변 접수 완료

### 5. 응답 조회 (장기 폴링)

```bash
curl "http://localhost:3000/v1/sessions/550e8400-e29b-41d4-a716-446655440000/replies?wait_sec=5" \
  -H "Authorization: Bearer my-secret"
# → {"session_id":"550e8400-...","status":"RESOLVED","replies":[{"reply_id":"...","type":"CHOICE","text":"예","choice":"예","created_at":"..."}]}
```

### 6. 인증 실패

```bash
curl http://localhost:3000/v1/sessions/test/replies
# → 401 {"error":"UNAUTHORIZED","message":"Missing or invalid Authorization header."}
```

## 현재 가정 / TODO

### 카카오 Payload 필드 (현재 가정)

카카오 스킬 서버가 보내는 JSON 구조를 다음과 같이 가정합니다:

```json
{
  "userRequest": {
    "user": { "id": "<kakao_user_key>" },
    "utterance": "<사용자 입력 텍스트>"
  }
}
```

- `userRequest.user.id` → `kakao_user_key`로 사용
- `userRequest.utterance` → 사용자 응답 텍스트로 사용
- 테스트 편의를 위해 `body.user_key` / `body.text` flat 구조도 fallback으로 허용

> **TODO**: 실제 카카오 i 오픈빌더 스킬 payload 스펙 확인 후 필드명 조정 필요.

### 기타 TODO

- 카카오 서명 검증 (시크릿 헤더)
- 세션 TTL (24h) 및 pending question timeout → EXPIRED 처리
- Reply TTL (24h) 정리
- 카카오 응답 JSON 규격 정밀화 (quickReplies, 버튼 등)
- 프로덕션 배포 시 DB(Redis/PostgreSQL) 교체
