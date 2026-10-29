import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface Session {
  id: string;
  expiresAt: number;
}

export class CapacityError extends Error {}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly ttlSeconds: number, private readonly limit = 10_000) {}

  getOrCreate(request: FastifyRequest, reply: FastifyReply): Session {
    const cookie = request.cookies.altcha_poc_sid;
    const existing = cookie ? this.sessions.get(cookie) : undefined;
    if (existing && existing.expiresAt > Date.now()) return existing;
    this.cleanup();
    if (this.sessions.size >= this.limit) throw new CapacityError('Session capacity reached');

    const session = {
      id: randomBytes(32).toString('hex'),
      expiresAt: Date.now() + this.ttlSeconds * 1000,
    };
    this.sessions.set(session.id, session);
    reply.setCookie('altcha_poc_sid', session.id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
      maxAge: this.ttlSeconds,
    });
    request.log.info({ event: 'session_created' }, 'Создана анонимная сессия');
    return session;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }
}
