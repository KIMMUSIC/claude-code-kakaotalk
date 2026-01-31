// ── Status Enum ──────────────────────────────────────────────
export type SessionStatus =
  | 'IDLE'
  | 'WAITING_USER'
  | 'RESOLVED'
  | 'EXPIRED'
  | 'CANCELED';

export type Severity = 'INFO' | 'WARNING' | 'DANGER';

export type ReplyType = 'TEXT' | 'CHOICE' | 'CANCEL';

// ── PendingQuestion ──────────────────────────────────────────
export interface PendingQuestion {
  message_id: string;
  text: string;
  choices?: string[];
  timeout_sec?: number;
  severity: Severity;
  metadata?: Record<string, unknown>;
  created_at: string; // RFC 3339
}

// ── Reply ────────────────────────────────────────────────────
export interface Reply {
  reply_id: string;
  type: ReplyType;
  text?: string;
  choice?: string;
  created_at: string; // RFC 3339
}

// ── Session ──────────────────────────────────────────────────
export interface Session {
  session_id: string;
  status: SessionStatus;
  pending_question: PendingQuestion | null;
  replies: Reply[];
  created_at: string; // RFC 3339
  updated_at: string; // RFC 3339
  owner_user_id?: string; // Mode B: Cognito user_id (세션 소유자)
}
