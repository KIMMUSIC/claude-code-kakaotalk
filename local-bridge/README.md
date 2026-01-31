# kakao-local-bridge

카카오톡 ↔ Claude Code HITL(Human-in-the-Loop) 브리지용 로컬 MCP 서버.

stdio 기반으로 동작하며, Claude Code에서 카카오톡 사용자에게 질문을 보내고 응답을 받을 수 있다.

## 환경변수

| 변수 | 필수 | 설명 |
|---|---|---|
| `RELAY_BASE_URL` | Y | Relay 서버 주소 (예: `http://localhost:3000`) |
| `AUTH_TOKEN` | Y | Relay 인증 Bearer 토큰 |
| `DEBUG` | N | `1`이면 디버그 로그 출력 |

> `AUTH_TOKEN`은 로그에 출력되지 않는다.

## 빌드 & 실행

```bash
cd local-bridge
npm install
npm run build
```

직접 실행 테스트 (stdio이므로 JSON-RPC 입력 필요):

```bash
AUTH_TOKEN=your-token RELAY_BASE_URL=http://localhost:3000 node dist/index.js
```

## Claude Code 설정

### .mcp.json (프로젝트 루트)

```json
{
  "mcpServers": {
    "kakao-local-bridge": {
      "command": "node",
      "args": ["./local-bridge/dist/index.js"],
      "env": {
        "RELAY_BASE_URL": "http://localhost:3000",
        "AUTH_TOKEN": "your-secret-token"
      }
    }
  }
}
```

### 도구 허용 설정

Claude Code에서 MCP 도구를 사용하려면 허용 설정이 필요하다.
`.claude/settings.local.json`에 추가:

```json
{
  "permissions": {
    "allow": [
      "mcp__kakao-local-bridge__kakao.ask_user",
      "mcp__kakao-local-bridge__kakao.notify_user"
    ]
  }
}
```

## MCP Tools

### kakao.ask_user

카카오톡 사용자에게 질문을 보내고 응답을 대기한다.

**Input:**

```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "text": "이 파일을 삭제해도 될까요?",
  "choices": ["예", "아니오"],
  "timeout_sec": 120,
  "severity": "WARNING"
}
```

**Output (성공):**

```json
{
  "status": "RESOLVED",
  "reply_text": "예",
  "choice": "예",
  "reply_id": "reply-uuid"
}
```

**Output (타임아웃):**

```json
{
  "status": "EXPIRED"
}
```

**Output (에러):**

```json
{
  "status": "ERROR",
  "error_code": "UNAUTHORIZED",
  "error_message": "Authentication failed."
}
```

**동작 흐름:**

1. Relay에 `POST /v1/sessions/{session_id}/questions` 호출
2. 성공(201) 시 `GET /v1/sessions/{session_id}/replies?wait_sec=25` long poll 반복
3. reply 수신 → `RESOLVED` 반환
4. `timeout_sec` 경과 → `EXPIRED` 반환
5. 네트워크 에러 → 지수 백오프(0.5s, 1s, 2s) 최대 3회 재시도 후 `ERROR`

### kakao.notify_user

사용자에게 알림을 보낸다. MVP에서는 콘솔 로그만 남기고 `ok: true` 반환.

**Input:**

```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "text": "작업이 완료되었습니다.",
  "severity": "INFO"
}
```

**Output:**

```json
{
  "ok": true
}
```

## 수동 E2E 테스트

### 사전 조건

Relay 서버가 실행 중이어야 한다:

```bash
cd relay-server
AUTH_TOKEN=test-token FIXED_USER_KEY=user123 npm start
```

### 테스트 절차

**1) 터미널 A: ask_user 호출**

MCP 서버를 직접 실행하고 JSON-RPC로 ask_user를 호출한다:

```bash
cd local-bridge
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kakao.ask_user","arguments":{"session_id":"550e8400-e29b-41d4-a716-446655440000","text":"계속할까요?","choices":["예","아니오"],"timeout_sec":60,"severity":"INFO"}}}' | AUTH_TOKEN=test-token RELAY_BASE_URL=http://localhost:3000 node dist/index.js
```

ask_user가 reply 대기 상태에 진입한다.

**2) 터미널 B: curl로 카카오 webhook reply 전송**

```bash
curl -X POST http://localhost:3000/webhook/kakao \
  -H "Content-Type: application/json" \
  -d '{
    "userRequest": {
      "user": { "id": "user123" },
      "utterance": "예"
    }
  }'
```

카카오 응답:
```json
{
  "version": "2.0",
  "template": {
    "outputs": [{ "simpleText": { "text": "응답을 접수했습니다." } }]
  }
}
```

**3) 터미널 A 결과 확인**

ask_user가 RESOLVED로 반환:

```json
{
  "status": "RESOLVED",
  "reply_text": "예",
  "choice": "예",
  "reply_id": "some-uuid"
}
```

### 에러 케이스 테스트

**인증 실패:**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kakao.ask_user","arguments":{"session_id":"test-session","text":"hello","severity":"INFO"}}}' | AUTH_TOKEN=wrong-token RELAY_BASE_URL=http://localhost:3000 node dist/index.js
```

→ `{ "status": "ERROR", "error_code": "UNAUTHORIZED" }`

**중복 질문 (409):**

동일 session_id로 ask_user를 두 번 호출하면 두 번째에서:

→ `{ "status": "ERROR", "error_code": "PENDING_EXISTS" }`

## 주의사항

- 각 `ask_user` 호출마다 고유한 `session_id` (UUID v4)를 사용할 것
- 한 번에 하나의 `ask_user`만 WAITING 상태가 되도록 유지 (Relay의 webhook이 가장 최근 세션 1개에만 reply를 적재)
- `AUTH_TOKEN`은 절대 로그에 출력하지 않음
- 모든 로그는 stderr로 출력 (stdout은 MCP 프로토콜 전용)
