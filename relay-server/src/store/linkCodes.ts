// ── Link Code Store: 챗봇 user.id ↔ 시스템 user_id 연동 코드 ──
// 카카오 챗봇에서 미연동 사용자 감지 시 일회성 코드를 발급한다.
// 코드를 POST /v1/link-chatbot 엔드포인트로 전송하면 연동 완료.

import crypto from 'crypto';

const LINK_CODE_TTL_MS = 10 * 60 * 1000; // 10분

interface LinkCodeEntry {
  chatbot_user_id: string;
  created_at: number;
}

const store = new Map<string, LinkCodeEntry>();

function cleanExpired(): void {
  const now = Date.now();
  for (const [code, entry] of store) {
    if (now - entry.created_at > LINK_CODE_TTL_MS) {
      store.delete(code);
    }
  }
}

/**
 * 챗봇 user.id에 대한 연동 코드 생성 (6자리 hex, 대문자)
 */
export function createLinkCode(chatbotUserId: string): string {
  cleanExpired();
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  store.set(code, { chatbot_user_id: chatbotUserId, created_at: Date.now() });
  return code;
}

/**
 * 연동 코드로 chatbot_user_id 조회 (일회성: 조회 후 삭제)
 */
export function resolveLinkCode(code: string): string | null {
  const entry = store.get(code.toUpperCase());
  if (!entry) return null;

  if (Date.now() - entry.created_at > LINK_CODE_TTL_MS) {
    store.delete(code.toUpperCase());
    return null;
  }

  store.delete(code.toUpperCase()); // 일회성 사용
  return entry.chatbot_user_id;
}
