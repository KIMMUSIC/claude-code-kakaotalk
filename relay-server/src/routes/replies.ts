import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { getOrCreateSession } from '../store';

const router = Router();

/**
 * GET /v1/sessions/:session_id/replies?since=<optional>&wait_sec=25
 *
 * - Auth 필수
 * - 세션 없으면 자동 생성 (IDLE, replies=[])
 * - wait_sec(기본 25초) 동안 reply 없으면 replies:[] 반환 (HTTP 200)
 * - since가 있으면 해당 reply_id 이후만 반환
 */
router.get(
  '/v1/sessions/:session_id/replies',
  requireAuth,
  async (
    req: Request<{ session_id: string }, unknown, unknown, { since?: string; wait_sec?: string }>,
    res: Response,
  ) => {
    const { session_id } = req.params;
    const sinceId = req.query.since as string | undefined;
    const waitSec = Math.min(
      Math.max(parseInt(req.query.wait_sec as string, 10) || 25, 0),
      60, // 최대 60초 제한
    );

    const session = getOrCreateSession(session_id, 'IDLE');

    // 장기 폴링: waitSec 동안 1초 간격으로 reply 확인
    const deadline = Date.now() + waitSec * 1000;

    const collectReplies = () => {
      let replies = session.replies;
      if (sinceId) {
        const idx = replies.findIndex((r) => r.reply_id === sinceId);
        if (idx >= 0) {
          replies = replies.slice(idx + 1);
        }
        // sinceId를 찾지 못하면 전체 반환
      }
      return replies;
    };

    // 즉시 reply가 있으면 바로 반환
    const immediate = collectReplies();
    if (immediate.length > 0) {
      res.json({
        session_id,
        status: session.status,
        replies: immediate,
      });
      return;
    }

    // 장기 폴링 루프
    const poll = () => {
      const replies = collectReplies();
      if (replies.length > 0 || Date.now() >= deadline) {
        res.json({
          session_id,
          status: session.status,
          replies,
        });
        return;
      }
      setTimeout(poll, 1000);
    };

    // 클라이언트 연결 끊김 처리
    req.on('close', () => {
      // 폴링 중단은 자연스럽게 처리됨 (res.json 호출 시 에러 무시)
    });

    setTimeout(poll, 1000);
  },
);

export default router;
