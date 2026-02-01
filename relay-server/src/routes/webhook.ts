import { Router, Request, Response } from 'express';
import {
  findMostRecentWaitingSession,
  findMostRecentWaitingSessionForUser,
  addReply,
  generateReplyId,
} from '../store';
import { ReplyType } from '../types';
import { getUserIdByKakaoUserKey, getUserIdByChatbotUserId } from '../services/tokenVault';
import { createLinkCode } from '../store/linkCodes';

const FIXED_USER_KEY = process.env.FIXED_USER_KEY ?? '';
const DDB_TABLE = process.env.DDB_TABLE_KAKAO_TOKENS ?? '';
const DEBUG = process.env.DEBUG === '1';

// Mode B 활성 여부: DDB 테이블이 설정되어 있으면 멀티유저 모드
const isMultiUserMode = !!DDB_TABLE;

// ── Webhook Diagnostics ─────────────────────────────────────
let webhookCallCount = 0;
let lastWebhookAt: string | null = null;

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
  // ── 진단: 요청 도착 기록 ──────────────────────────────────
  webhookCallCount++;
  lastWebhookAt = new Date().toISOString();

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

  // ── 진단: 항상 로그 출력 (민감값 마스킹) ──────────────────
  console.log(
    `[webhook] #${webhookCallCount} id_chain: appUserId=${!!appUserId} kakaoUserId=${!!kakaoUserId} fallback=${!!req.body?.user_key} resolved=${userKey ? maskKey(userKey) : 'none'}`,
  );

  if (DEBUG && userKey) {
    console.log(`[webhook:debug] userKey=${maskKey(userKey)} utterance_length=${utterance?.length ?? 0}`);
  }

  if (!userKey) {
    console.log('[webhook] outcome=no_user_key');
    res.json(kakaoResponse('사용자를 식별할 수 없습니다.'));
    return;
  }

  // ── 사용자 식별 + 세션 검색 ──────────────────────────────
  let userId: string | null = null;

  if (isMultiUserMode) {
    // ── Mode B: DDB GSI 역조회 (kakao_user_key → chatbot_user_id 순) ──
    try {
      userId = await getUserIdByKakaoUserKey(userKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[webhook] DDB kakao_user_key lookup error: ${msg}`);
    }

    // kakao_user_key로 못 찾으면 chatbot_user_id GSI로 재시도
    if (!userId) {
      try {
        userId = await getUserIdByChatbotUserId(userKey);
        if (userId) {
          console.log(`[webhook] found via chatbot_user_id GSI userId=${userId}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[webhook] DDB chatbot_user_id lookup error: ${msg}`);
      }
    }

    if (!userId && FIXED_USER_KEY && userKey === FIXED_USER_KEY) {
      // Mode A 호환: FIXED_USER_KEY와 일치하면 전역 검색으로 fallback
      userId = null; // null이면 아래에서 Mode A 로직 사용
    } else if (!userId) {
      // 연동 코드 발급
      const linkCode = createLinkCode(userKey);
      console.log(`[webhook] outcome=unlinked_user key=${userKey} link_code=${linkCode}`);
      res.json(kakaoResponse(
        `연동이 필요합니다.\n연동 코드: ${linkCode}\n\n이 코드를 Claude Code에 알려주세요.`,
      ));
      return;
    }
  } else {
    // ── Mode A: FIXED_USER_KEY 단일 사용자 ────────────────
    if (userKey !== FIXED_USER_KEY) {
      console.log(`[webhook] outcome=rejected_user key=${maskKey(userKey)}`);
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
    console.log(`[webhook] outcome=no_waiting_session userId=${userId ?? 'global'}`);
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

    console.log(`[webhook] outcome=query_mode session=${session.session_id}`);
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
  console.log(`[webhook] outcome=reply_stored session=${session.session_id} type=${replyType}`);
  res.json(kakaoResponse('응답을 접수했습니다.'));
});

/**
 * GET /webhook/kakao/health
 *
 * 웹훅 도달 가능성 진단 엔드포인트.
 * Auth 없음 (카카오에서 접근 가능해야 하며, 민감정보 노출 없음).
 */
router.get('/webhook/kakao/health', (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    webhook_path: '/webhook/kakao',
    stats: {
      total_calls: webhookCallCount,
      last_call_at: lastWebhookAt,
      fixed_user_key_configured: !!FIXED_USER_KEY,
      multi_user_mode: isMultiUserMode,
    },
  });
});

export default router;
