import 'express';

declare module 'express' {
  interface Request {
    /** 인증 성공 시 설정되는 사용자 정보 */
    auth?: {
      /** Cognito JWT sub (Mode B) 또는 'static-token' (Mode A) */
      user_id: string;
      /** 인증 방식 */
      method: 'cognito_jwt' | 'static_token';
    };
  }
}
