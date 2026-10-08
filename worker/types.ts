import type { Hono } from 'hono';

export type Role = 'ADMIN' | 'OFFICER';
export type AuthContext = { sessionId: string; userId: string; username: string; role: Role; expiresAt: number };
export type AppEnv = { Bindings: Env; Variables: { requestId: string; auth?: AuthContext } };
export type App = Hono<AppEnv>;
