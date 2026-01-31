import { Router, Request, Response } from 'express';
import {
  findMostRecentWaitingSession,
  findMostRecentWaitingSessionForUser,
  addReply,
  generateReplyId,
} from '../store';
import { ReplyType } from '../types';
import { getUserIdByKakaoUserKey } from '../services/tokenVault';

const FIXED_USER_KEY = process.env.FIXED_USER_KEY ?? '';
const DDB_TABLE = process.env.DDB_TABLE_KAKAO_TOKENS ?? '';
const DEBUG = process.env.DEBUG === '1';

// Mode B 활성 여부: DDB 테이블이 설정되어 있으면 멀티유저 모드
const isMultiUserMode = !!DDB_TABLE;

function maskKey(key: string): string {
  if (key.length <= 10) return key.slice(0, 3) + '***';
  return key.slice(0, 6) + '***' + key.slice(-4);
}

function kakaoResponse(text: string): object {
  return {
    version: '2.0',
    template: {
      outputs: [{ simpleText: { text } }],
    },
  };
}

const router = Router();

/**
 * POST /webhook/kakao
 *
 * 카카오 스킬 웹훅 payload를 수신한다.
 *
 * - Mode A (FIXED_USER_KEY): 단일 사용자 허용, 전역 세션 검색
 * - Mode B (DDB 멀티유저): kakao_user_key → user_id GSI 역조회, 사용자 스코프 세션 검색
 */
router.post('/webhook/kakao', async (req: Request, res: Response) => {
  // ── 카카오 payload 파싱 ────────────────────────────────
  const userRequest = req.body?.userRequest;
  const utterance: string | undefined = userRequest?.utterance;

  // userKey 추출 우선순위:
  // 1) appUserId (카카오 싱크 연동 시)
  // 2) user.id (카카오 스킬 기본)
  // 3) body.user_key (테스트 fallback)
  const appUserId: string | undefined = userRequest?.user?.properties?.appUserId;
  const kakaoUserId: string | undefined = userRequest?.user?.id;
  const userKey = appUserId ?? kakaoUserId ?? req.body?.user_key;
  const userText = utterance ?? req.body?.text ?? '';

  if (DEBUG && userKey) {
    console.log(`[webhook] userKey=${maskKey(userKey)}`);
  }

  if (!userKey) {
    res.json(kakaoResponse('사용자를 식별할 수 없습니다.'));
    return;
  }

  // ── 사용자 식별 + 세션 검색 ──────────────────────────────
  let userId: string | null = null;

  if (isMultiUserMode) {
    // ── Mode B: DDB GSI 역조회 ────────────────────────────
    try {
      userId = await getUserIdByKakaoUserKey(userKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[webhook] DDB lookup error: ${msg}`);
      // DDB 오류 시 Mode A fallback 시도
    }

    if (!userId && FIXED_USER_KEY && userKey === FIXED_USER_KEY) {
      // Mode A 호환: FIXED_USER_KEY와 일치하면 전역 검색으로 fallback
      userId = null; // null이면 아래에서 Mode A 로직 사용
    } else if (!userId) {
      res.json(kakaoResponse('연동되지 않은 사용자입니다. 먼저 연동을 완료해주세요.'));
      return;
    }
  } else {
    // ── Mode A: FIXED_USER_KEY 단일 사용자 ────────────────
    if (userKey !== FIXED_USER_KEY) {
      res.json(kakaoResponse('허용되지 않은 사용자입니다.'));
      return;
    }
  }

  // ── 질문 조회 키워드 판별 ──────────────────────────────
  const QUERY_KEYWORDS = ['pending', '질문', '?'];
  const normalizedText = userText.trim().toLowerCase();
  const isQueryMode = QUERY_KEYWORDS.includes(normalizedText);

  // ── WAITING_USER 세션 찾기 ─────────────────────────────
  const session = userId
    ? findMostRecentWaitingSessionForUser(userId) // Mode B: 사용자 스코프
    : findMostRecentWaitingSession();              // Mode A: 전역 검색

  if (!session) {
    res.json(kakaoResponse('현재 대기 중인 질문이 없습니다.'));
    return;
  }

  // ── 질문 조회 모드: 질문 내용만 보여주고 reply하지 않음 ──
  if (isQueryMode) {
    const question = session.pending_question;
    const questionText = question?.text ?? '(질문 내용 없음)';

    const template: Record<string, unknown> = {
      outputs: [{ simpleText: { text: questionText } }],
    };

    if (question?.choices?.length) {
      template.quickReplies = question.choices.map((c) => ({
        label: c,
        action: 'message',
        messageText: c,
      }));
    }

    res.json({ version: '2.0', template });
    return;
  }

  // ── 답변 모드: reply 타입 결정 ─────────────────────────
  // pending_question에 choices가 있고 사용자 텍스트가 choices 중 하나와 일치하면 CHOICE
  let replyType: ReplyType = 'TEXT';
  let choice: string | undefined;

  if (session.pending_question?.choices?.length) {
    const matched = session.pending_question.choices.find(
      (c) => c.trim().toLowerCase() === normalizedText,
    );
    if (matched) {
      replyType = 'CHOICE';
      choice = matched;
    }
  }

  // ── reply 적재 ─────────────────────────────────────────
  addReply(session, {
    reply_id: generateReplyId(),
    type: replyType,
    text: userText || undefined,
    choice,
    created_at: new Date().toISOString(),
  });

  // ── 카카오 응답 ────────────────────────────────────────
  res.json(kakaoResponse('응답을 접수했습니다.'));
});

export default router;
