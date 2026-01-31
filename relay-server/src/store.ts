import { Session, SessionStatus, PendingQuestion, Reply } from './types';
import { v4 as uuidv4 } from 'uuid';

// ── In-memory Session Store ──────────────────────────────────
// MVP: 단순 Map. TTL/정리는 TODO.
const sessions = new Map<string, Session>();

function now(): string {
  return new Date().toISOString();
}

// ── Helpers ──────────────────────────────────────────────────

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

export function getOrCreateSession(
  sessionId: string,
  initialStatus: SessionStatus,
  ownerUserId?: string,
): Session {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      session_id: sessionId,
      status: initialStatus,
      pending_question: null,
      replies: [],
      created_at: now(),
      updated_at: now(),
      owner_user_id: ownerUserId,
    };
    sessions.set(sessionId, session);
  }
  return session;
}

export function setPendingQuestion(
  session: Session,
  question: PendingQuestion,
): void {
  session.pending_question = question;
  session.status = 'WAITING_USER';
  session.updated_at = now();
}

export function addReply(session: Session, reply: Reply): void {
  session.replies.push(reply);
  session.pending_question = null;
  session.status = 'RESOLVED';
  session.updated_at = now();
}

/**
 * WAITING_USER 상태인 세션 중 updatedAt이 가장 최신인 1개를 반환한다.
 * (Mode A: 전역 검색, 카카오 웹훅 → reply 매핑용)
 */
export function findMostRecentWaitingSession(): Session | undefined {
  let latest: Session | undefined;
  for (const session of sessions.values()) {
    if (session.status !== 'WAITING_USER') continue;
    if (!latest || session.updated_at > latest.updated_at) {
      latest = session;
    }
  }
  return latest;
}

/**
 * 특정 user_id 소유의 WAITING_USER 세션 중 가장 최신 1개를 반환한다.
 * (Mode B: 멀티유저 웹훅 → reply 매핑용)
 */
export function findMostRecentWaitingSessionForUser(userId: string): Session | undefined {
  let latest: Session | undefined;
  for (const session of sessions.values()) {
    if (session.status !== 'WAITING_USER') continue;
    if (session.owner_user_id !== userId) continue;
    if (!latest || session.updated_at > latest.updated_at) {
      latest = session;
    }
  }
  return latest;
}

export function generateMessageId(): string {
  return uuidv4();
}

export function generateReplyId(): string {
  return uuidv4();
}

// TODO: TTL 기반 세션 만료 처리 (24h session, pending timeout_sec → EXPIRED)
