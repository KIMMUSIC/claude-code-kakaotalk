import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { kakaoSender, senderEnabled } from '../outbound/kakaoSender';
import { Severity } from '../types';

const router = Router();

interface NotifyBody {
  session_id: string;
  text: string;
  severity?: Severity;
  target_user_id?: string; // Mode B
}

/**
 * POST /v1/notify
 *
 * - Auth 필수 (questions 엔드포인트와 동일)
 * - 일방향 알림 발송 (reply 기대하지 않음)
 * - Mode B: target_user_id 필수, caller==target 검증
 */
router.post(
  '/v1/notify',
  requireAuth,
  async (req: Request<unknown, unknown, NotifyBody>, res: Response) => {
    const { session_id, text, severity = 'INFO', target_user_id } = req.body;

    if (!session_id || !text) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'session_id and text are required.',
      });
      return;
    }

    // Mode B: target_user_id 권한 검증
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

    // Mode B: Cognito auth → target_user_id 또는 caller의 sub 사용
    // Mode A: static token → 요청 body의 target_user_id를 그대로 전달
    const resolvedUserId = isCognitoAuth
      ? (target_user_id ?? req.auth!.user_id)
      : target_user_id;

    if (!senderEnabled) {
      console.log(`[notify] sender_disabled session=${session_id}`);
      res.status(200).json({ ok: true, message: 'Notification logged (sender disabled).' });
      return;
    }

    try {
      const result = await kakaoSender.sendNotification({
        session_id,
        text,
        severity,
        target_user_id: resolvedUserId,
      });

      if (result.ok) {
        res.status(200).json({
          ok: true,
          provider_message_id: result.provider_message_id,
        });
      } else {
        console.error(`[notify] sender_failed session=${session_id} error=${result.error_code}`);
        res.status(502).json({
          ok: false,
          error_code: result.error_code,
          error_message: result.error_message,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[notify] error session=${session_id}: ${msg}`);
      res.status(500).json({
        ok: false,
        error_code: 'INTERNAL_ERROR',
        error_message: 'Failed to send notification.',
      });
    }
  },
);

export default router;
