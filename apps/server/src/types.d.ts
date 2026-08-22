// 扩展 Fastify JWT 类型，payload 和 user 都只携带 sub（用户 id）
import '@fastify/jwt';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: number };
    user: { sub: number };
  }
}
