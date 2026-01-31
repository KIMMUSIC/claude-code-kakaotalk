import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  getOrCreateSession,
  setPendingQuestion,
  generateMessageId,
} from '../store';
import { Severity } from '../types';
import { kakaoSender, senderEnabled } from '../outbound/kakaoSender';

const FIXED_USER_KEY = process.env.FIXED_USER_KEY ?? '';

const router = Router();

interface QuestionsBody {
  text: string;
  choices?: string[];
  timeout_sec?: number;
  severity: Severity;
  metadata?: Record<string, unknown>;
  target_user_id?: string; // Mode B
}

/**
 * POST /v1/sessions/:session_id/questions
 *
 * - Auth 필수
 * - 세션 없으면 자동 생성 (WAITING_USER)
 * - pending_question 있으면 409 Conflict
 * - 없으면 저장 후 WAITING_USER
 * - Mode B: target_user_id 필수, caller==target 검증
 */
router.post(
  '/v1/sessions/:session_id/questions',
  requireAuth,
  (req: Request<{ session_id: string }, unknown, QuestionsBody>, res: Response) => {
    const { session_id } = req.params;
    const { text, choices, timeout_sec, severity, metadata, target_user_id } = req.body;

    if (!text || !severity) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'text and severity are required.',
      });
      return;
    }

    // ── Mode B: target_user_id 권한 검증 ─────────────────
    const isCognitoAuth = req.auth?.method === 'cognito_jwt';
    if (isCognitoAuth && target_user_id) {
      if (req.auth!.user_id !== target_user_id) {
        res.status(403).json({
          error: 'FORBIDDEN',
          message: 'caller_user_id must match target_user_id in MVP.',
        });
        return;
      }
    }

    // owner_user_id: Mode B에서는 target_user_id 또는 caller, Mode A에서는 undefined
    const ownerUserId = isCognitoAuth
      ? (target_user_id ?? req.auth!.user_id)
      : undefined;

    const session = getOrCreateSession(session_id, 'WAITING_USER', ownerUserId);

    // D-2: pending_question이 이미 존재하면 409
    if (session.status === 'WAITING_USER' && session.pending_question) {
      res.status(409).json({
        error: 'PENDING_EXISTS',
        message: 'A pending question already exists for this session.',
      });
      return;
    }

    const message_id = generateMessageId();

    setPendingQuestion(session, {
      message_id,
      text,
      choices,
      timeout_sec,
      severity,
      metadata,
      created_at: new Date().toISOString(),
    });

    res.status(201).json({
      session_id,
      message_id,
      status: 'WAITING_USER',
    });

    // ── Outbound push (fire-and-forget) ──────────────────
    if (senderEnabled) {
      kakaoSender
        .sendQuestion({
          session_id,
          message_id,
          question_text: text,
          choices: choices ?? [],
          kakao_user_key: FIXED_USER_KEY,
          target_user_id: ownerUserId,
        })
        .catch((err: unknown) => {
          // sender 실패해도 API 201 유지, 로그만 남긴다
          // AUTH_TOKEN 노출 금지 — err.message만 기록
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[send_failed] session=${session_id} message=${message_id} error=${msg}`);
        });
    } else {
      console.log(`[sender_disabled] session=${session_id} message=${message_id}`);
    }
  },
);

export default router;
