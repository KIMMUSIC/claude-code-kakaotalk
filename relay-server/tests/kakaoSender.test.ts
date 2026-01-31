import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildMessageText,
  buildSendPayload,
  TokenManager,
  BizMessageConfig,
  SendQuestionInput,
} from '../src/outbound/kakaoSender';

// ── buildMessageText ───────────────────────────────────────

describe('buildMessageText', () => {
  it('choices가 없으면 질문 + 안내만 포함', () => {
    const result = buildMessageText('배포할까요?', []);
    assert.equal(result, '배포할까요?\n(응답: pending 또는 버튼 선택)');
  });

  it('choices가 있으면 선택지 목록 포함', () => {
    const result = buildMessageText('계속할까요?', ['예', '아니오']);
    assert.equal(
      result,
      '계속할까요?\n\n선택지: 예, 아니오\n(응답: pending 또는 버튼 선택)',
    );
  });

  it('choices가 3개 이상이면 쉼표로 연결', () => {
    const result = buildMessageText('선택하세요', ['A', 'B', 'C']);
    assert.ok(result.includes('선택지: A, B, C'));
  });
});

// ── buildSendPayload ───────────────────────────────────────

describe('buildSendPayload', () => {
  const config: BizMessageConfig = {
    baseUrl: 'bizmsg-web.kakaoenterprise.com',
    clientId: 'test-client',
    clientSecret: 'test-secret',
    senderKey: 'sk-123',
    templateCode: 'TPL_001',
    senderNo: '01012345678',
    phoneNumber: '01087654321',
  };

  const input: SendQuestionInput = {
    session_id: 'sess-001',
    message_id: 'msg-001',
    question_text: 'push 할까요?',
    choices: ['예', '아니오'],
    kakao_user_key: 'user-key-1',
  };

  it('필수 필드가 모두 포함됨', () => {
    const payload = buildSendPayload(config, input);
    assert.equal(payload.message_type, 'AT');
    assert.equal(payload.sender_key, 'sk-123');
    assert.equal(payload.cid, 'msg-001');
    assert.equal(payload.template_code, 'TPL_001');
    assert.equal(payload.phone_number, '01087654321');
    assert.equal(payload.sender_no, '01012345678');
    assert.equal(payload.fall_back_yn, false);
  });

  it('message에 질문 텍스트와 선택지가 포함됨', () => {
    const payload = buildSendPayload(config, input);
    const msg = payload.message as string;
    assert.ok(msg.includes('push 할까요?'));
    assert.ok(msg.includes('선택지: 예, 아니오'));
  });

  it('cid는 message_id와 동일', () => {
    const payload = buildSendPayload(config, input);
    assert.equal(payload.cid, input.message_id);
  });
});

// ── TokenManager ───────────────────────────────────────────

describe('TokenManager', () => {
  it('초기 상태에서 isExpired는 true', () => {
    const tm = new TokenManager('example.com', 'id', 'secret');
    assert.equal(tm.isExpired(), true);
  });

  it('유효한 토큰이 설정되면 isExpired는 false', () => {
    const tm = new TokenManager('example.com', 'id', 'secret');
    tm.setToken('valid-token', Date.now() + 120_000); // 2분 후 만료
    assert.equal(tm.isExpired(), false);
  });

  it('만료 60초 전이면 isExpired는 true', () => {
    const tm = new TokenManager('example.com', 'id', 'secret');
    tm.setToken('expiring-token', Date.now() + 59_000); // 59초 후 만료 (margin 60초 이내)
    assert.equal(tm.isExpired(), true);
  });

  it('이미 만료된 토큰이면 isExpired는 true', () => {
    const tm = new TokenManager('example.com', 'id', 'secret');
    tm.setToken('expired-token', Date.now() - 1000);
    assert.equal(tm.isExpired(), true);
  });

  it('유효 토큰이면 getToken은 네트워크 호출 없이 반환', async () => {
    const tm = new TokenManager('example.com', 'id', 'secret');
    tm.setToken('cached-token', Date.now() + 120_000);
    const token = await tm.getToken();
    assert.equal(token, 'cached-token');
  });
});
