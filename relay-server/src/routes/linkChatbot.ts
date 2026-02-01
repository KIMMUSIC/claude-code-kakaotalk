import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { resolveLinkCode } from '../store/linkCodes';
import { saveChatbotUserId } from '../services/tokenVault';

const router = Router();

interface LinkBody {
  link_code: string;
  target_user_id?: string; // Mode B
}

/**
 * POST /v1/link-chatbot
 *
 * 카카오 챗봇에서 발급된 연동 코드를 사용하여
 * 챗봇 user.id와 시스템 user_id를 연결한다.
 *
 * - Auth 필수
 * - link_code 필수
 * - Mode A: 요청자의 target_user_id 사용
 * - Mode B: caller == target_user_id 검증
 */
router.post(
  '/v1/link-chatbot',
  requireAuth,
  async (req: Request<unknown, unknown, LinkBody>, res: Response) => {
    const { link_code, target_user_id } = req.body;

    if (!link_code) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'link_code is required.',
      });
      return;
    }

    // user_id 결정
    const isCognitoAuth = req.auth?.method === 'cognito_jwt';
    const userId = isCognitoAuth
      ? (target_user_id ?? req.auth!.user_id)
      : target_user_id;

    if (!userId) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'target_user_id is required.',
      });
      return;
    }

    // Mode B: caller == target 검증
    if (isCognitoAuth && target_user_id && req.auth!.user_id !== target_user_id) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'caller_user_id must match target_user_id.',
      });
      return;
    }

    // 연동 코드 검증
    const chatbotUserId = resolveLinkCode(link_code);
    if (!chatbotUserId) {
      res.status(400).json({
        error: 'INVALID_CODE',
        message: 'Invalid or expired link code.',
      });
      return;
    }

    try {
      await saveChatbotUserId(userId, chatbotUserId);
      console.log(`[link-chatbot] linked user_id=${userId} chatbot_user_id=${chatbotUserId}`);
      res.status(200).json({
        ok: true,
        message: '챗봇 연동이 완료되었습니다.',
        chatbot_user_id: chatbotUserId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[link-chatbot] error: ${msg}`);
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Failed to save chatbot link.',
      });
    }
  },
);

export default router;
