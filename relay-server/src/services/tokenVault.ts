// ── Token Vault: KMS 암호화 + DynamoDB 저장/조회 ────────────
// Kakao OAuth 토큰을 KMS로 암호화하여 DynamoDB에 저장/조회한다.
// 민감값(토큰, 시크릿)은 로그에 절대 출력하지 않는다.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';

// ── ENV ────────────────────────────────────────────────────
const REGION = process.env.COGNITO_REGION || 'ap-northeast-2';
const DDB_TABLE = process.env.DDB_TABLE_KAKAO_TOKENS || '';
const KMS_KEY_ID = process.env.KMS_KEY_ID || '';

// ── AWS Clients (lazy init) ───────────────────────────────
let _ddbDoc: DynamoDBDocumentClient | null = null;
let _kms: KMSClient | null = null;

function getDdbDoc(): DynamoDBDocumentClient {
  if (!_ddbDoc) {
    _ddbDoc = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: REGION }),
    );
  }
  return _ddbDoc;
}

function getKms(): KMSClient {
  if (!_kms) {
    _kms = new KMSClient({ region: REGION });
  }
  return _kms;
}

// ── KMS 암호화/복호화 ─────────────────────────────────────

async function encryptToken(plaintext: string): Promise<string> {
  const command = new EncryptCommand({
    KeyId: KMS_KEY_ID,
    Plaintext: Buffer.from(plaintext, 'utf-8'),
  });
  const result = await getKms().send(command);
  if (!result.CiphertextBlob) {
    throw new Error('KMS encryption returned no ciphertext');
  }
  return Buffer.from(result.CiphertextBlob).toString('base64');
}

async function decryptToken(cipherBase64: string): Promise<string> {
  const command = new DecryptCommand({
    CiphertextBlob: Buffer.from(cipherBase64, 'base64'),
  });
  const result = await getKms().send(command);
  if (!result.Plaintext) {
    throw new Error('KMS decryption returned no plaintext');
  }
  return Buffer.from(result.Plaintext).toString('utf-8');
}

// ── Types ─────────────────────────────────────────────────

export interface SaveKakaoTokensInput {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch seconds
  scope: string;
  kakao_user_key?: string;
}

export interface KakaoTokenRecord {
  user_id: string;
  access_token: string;  // 복호화된 평문
  refresh_token: string; // 복호화된 평문
  expires_at: number;    // epoch seconds
  scope: string;
  kakao_user_key?: string;
}

// ── Token 저장 ────────────────────────────────────────────

export async function saveKakaoTokens(input: SaveKakaoTokensInput): Promise<void> {
  if (!DDB_TABLE) throw new Error('DDB_TABLE_KAKAO_TOKENS is not configured');
  if (!KMS_KEY_ID) throw new Error('KMS_KEY_ID is not configured');

  // 두 토큰을 병렬로 암호화
  const [accessEnc, refreshEnc] = await Promise.all([
    encryptToken(input.access_token),
    encryptToken(input.refresh_token),
  ]);

  const now = new Date().toISOString();
  // TTL: 90일 (refresh token 만료 여유)
  const ttl = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;

  const item: Record<string, unknown> = {
    user_id: input.user_id,
    kakao_access_token_enc: accessEnc,
    kakao_refresh_token_enc: refreshEnc,
    expires_at: input.expires_at,
    scope: input.scope,
    updated_at: now,
    ttl,
  };

  if (input.kakao_user_key) {
    item.kakao_user_key = input.kakao_user_key;
  }

  await getDdbDoc().send(
    new PutCommand({
      TableName: DDB_TABLE,
      Item: item,
    }),
  );
}

// ── Token 조회 (user_id 기준) ─────────────────────────────

export async function getKakaoTokens(userId: string): Promise<KakaoTokenRecord | null> {
  if (!DDB_TABLE) throw new Error('DDB_TABLE_KAKAO_TOKENS is not configured');

  const result = await getDdbDoc().send(
    new GetCommand({
      TableName: DDB_TABLE,
      Key: { user_id: userId },
    }),
  );

  if (!result.Item) return null;

  const item = result.Item as Record<string, unknown>;
  const accessEnc = item.kakao_access_token_enc as string | undefined;
  const refreshEnc = item.kakao_refresh_token_enc as string | undefined;

  if (!accessEnc || !refreshEnc) return null;

  // 병렬 복호화
  const [accessToken, refreshToken] = await Promise.all([
    decryptToken(accessEnc),
    decryptToken(refreshEnc),
  ]);

  return {
    user_id: userId,
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: (item.expires_at as number) ?? 0,
    scope: (item.scope as string) ?? '',
    kakao_user_key: item.kakao_user_key as string | undefined,
  };
}

// ── user_id 역조회 (kakao_user_key GSI) ───────────────────

export async function getUserIdByKakaoUserKey(kakaoUserKey: string): Promise<string | null> {
  if (!DDB_TABLE) throw new Error('DDB_TABLE_KAKAO_TOKENS is not configured');

  const result = await getDdbDoc().send(
    new QueryCommand({
      TableName: DDB_TABLE,
      IndexName: 'kakao_user_key-index',
      KeyConditionExpression: 'kakao_user_key = :k',
      ExpressionAttributeValues: { ':k': kakaoUserKey },
      Limit: 1,
    }),
  );

  if (!result.Items || result.Items.length === 0) return null;
  return (result.Items[0].user_id as string) ?? null;
}
