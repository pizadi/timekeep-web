import type { WsEvent } from '../shared/constants';

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  USER_HUB: DurableObjectNamespace;
  R2?: R2Bucket;                 // optional (FR-D3 dumps)
  ASSETS: Fetcher;

  // vars
  PBKDF2_ITERATIONS: string;
  ALLOWED_ORIGINS: string;
  EMAIL_DEV_MODE: string;
  FROM_EMAIL: string;
  TURNSTILE_SITE_KEY?: string;
  // optional dev/test overrides for NFR-3 rate limits (see middleware.rateRules)
  RL_LOGIN_IP?: string;
  RL_LOGIN_EMAIL?: string;
  RL_SIGNUP_IP?: string;
  RL_RESET_EMAIL?: string;
  RL_TOKEN_IP?: string;
  RL_ADMIN_IP?: string;
  RL_API_USER?: string;

  // secrets
  // NOTE: no SESSION_SECRET — session tokens are 256-bit random, hashed at rest.
  TURNSTILE_SECRET_KEY?: string;
  RESEND_API_KEY?: string;
}

export type UserRole = 'user' | 'admin';

export type WorkerType = {
  Bindings: Env;
  Variables: {
    user: {
      id: string; username: string; email: string; name: string; timezone: string;
      week_start: number; theme: 'system' | 'light' | 'dark';
      role: UserRole; active: 0 | 1; must_change_password: 0 | 1;
      email_verified_at: number | null; created_at: number;
    };
    deviceId: string;
    authSessionId: string;
  };
};

export interface UserInfo {
  id: string;
  username: string;
  email: string;
  name: string;
  timezone: string;
  week_start: number;
  theme: 'system' | 'light' | 'dark';
  role: UserRole;
  must_change_password: boolean;
  email_verified_at: number | null;
  created_at: number;
}

export const jsonError = (status: number, code: string, message: string, details?: unknown) =>
  Response.json({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, { status });

export { WsEvent };
