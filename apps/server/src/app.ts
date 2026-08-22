import Fastify, { LogController, type FastifyReply, type FastifyRequest } from 'fastify';
// 服务端核心：全部 REST 路由 + WebSocket + 管理面板托管
// 路由分组：认证 → 资料 → 联系人 → 群组 → 消息 → QQ 管理 → 管理面板
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import websocket from '@fastify/websocket';
import nodemailer from 'nodemailer';
import type { WebSocket } from 'ws';
import { randomInt, randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import { createReadStream, createWriteStream, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { ADMIN_SCOPES, DomainError, addGroupMember, createGroup, forceJoinGroup, generatePlatformAdminCodes, generateVipCodes, hasScope, isPlatformAdmin, isVip, redeemPlatformAdminCode, redeemVipCode, vipDurationSeconds, type AdminScope, type VipDuration } from './domain.js';
import { hashPassword, randomToken, safeEqualHex, sha256, verifyPassword } from './security.js';

type JsonObject = Record<string, unknown>;
type AdminIdentity = { actor: string; root: boolean; scopes: string };

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const dummyPasswordHashPromise = hashPassword('constant-time-placeholder-password');
const DISCLAIMER_VERSION = '2026-08-14';
const DISCLAIMER = {
  version: DISCLAIMER_VERSION,
  title: '通信与平台治理说明',
  sections: [
    '消息正文采用端到端加密，服务器没有解密密钥，平台管理员也无法读取正文。离线时，服务器会限时保留收件人专属的加密信封，送达确认或到期后删除。',
    '服务器会处理提供服务和治理所需的元数据，例如账号、联系人和群成员关系、消息标识、发送方、接收方或群组、时间、在线状态以及管理操作记录。',
    '平台管理员不能全局封禁或禁言用户，不能干预私聊、隐藏参与或冒充用户。平台管理员可以公开强制加入任意群组；只有成为该群可见成员后，才在该群拥有高于群主的治理权限。',
    '已公开加入群组的平台管理员可以审核入群、设置成员角色和群设置、移除成员、限时禁言包括群主在内的成员（不能处置另一名有效平台管理员），并可仅凭消息标识生成不含正文的移除墓碑。',
    '消息正文解密后的历史仅保存在用户设备。服务器的密文队列只用于离线送达，并在送达确认或配置的短期保留期限到期时删除；它不是云端聊天记录。附件由服务器临时中转（保留期限内可下载），超过保留期限自动清理。',
    '请对自己发送的内容、共享对象和设备安全负责。本说明用于透明告知服务行为，不排除或放弃任何依法享有的权利。',
  ],
};

export async function buildApp(config: Config, db: Database) {
  const serviceStartedAt = Date.now();
  const app = Fastify({
    logger: { redact: ['req.headers.authorization', 'req.headers.x-admin-key', 'body.password', 'body.code'] },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 128 * 1024,
    trustProxy: true,
  });
  await app.register(helmet, { contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  } });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await app.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: '7d' } });
  await app.register(websocket, { options: { maxPayload: 20 * 1024 * 1024 } });

  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  await app.register(staticPlugin, {
    root: publicDir,
    prefix: '/admin/',
    decorateReply: false,
    cacheControl: false,
  });

  // 管理面板静态文件禁止缓存，修复即时生效
  app.addHook('onSend', async (request, reply, payload) => {
    if (String(request.url).startsWith('/admin')) {
      reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      reply.header('Pragma', 'no-cache');
      reply.header('Expires', '0');
    }
    return payload;
  });

  const mailer = config.smtp ? nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  }) : undefined;

  function audit(actor: string, action: string, target: string | null, metadata: JsonObject, request?: FastifyRequest) {
    db.prepare('INSERT INTO audit_log(actor, action, target, metadata, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(actor, action, target, JSON.stringify(metadata), request?.ip ?? null, Date.now());
  }

  function encryptedEnvelope(value: unknown): value is { algorithm: string; ciphertext: string; iv: string } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const envelope = value as Record<string, unknown>;
    return typeof envelope.algorithm === 'string' && envelope.algorithm.length > 0 && envelope.algorithm.length <= 64
      && typeof envelope.ciphertext === 'string' && envelope.ciphertext.length > 0 && envelope.ciphertext.length <= 60_000
      && envelope.algorithm === 'ECDH-P256/AES-256-GCM'
      && envelope.version === 1
      && typeof envelope.iv === 'string' && envelope.iv.length > 0 && envelope.iv.length <= 256
      && typeof envelope.ephemeralPublicKey === 'object' && envelope.ephemeralPublicKey !== null
      && !('plaintext' in envelope);
  }

  function publicIdentity(value: unknown): value is { algorithm: 'ECDH-P256'; publicKey: Record<string, unknown>; fingerprint: string } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const identity = value as Record<string, unknown>; const key = identity.publicKey as Record<string, unknown> | undefined;
    return identity.algorithm === 'ECDH-P256' && typeof identity.fingerprint === 'string' && identity.fingerprint.length >= 16 && identity.fingerprint.length <= 128
      && Boolean(key && key.kty === 'EC' && key.crv === 'P-256' && typeof key.x === 'string' && typeof key.y === 'string' && !('d' in key));
  }

  function appUser(userId: number) {
    const row = db.prepare(`SELECT id,uuid,email,display_name,avatar_url,bio,gender,public_identity,identity_fingerprint,last_seen_at,banned_at,banned_until,ban_reason,
      platform_admin_at,platform_admin_revoked_at FROM users WHERE id=?`).get(userId) as Record<string, unknown> | undefined;
    if (!row) throw new DomainError(404, 'User not found');
    const vip = db.prepare('SELECT expires_at FROM vip_entitlements WHERE user_id=? AND (expires_at=0 OR expires_at>?)').get(userId, Date.now()) as { expires_at: number } | undefined;
    const vipInfo = db.prepare(`SELECT v.duration_seconds durationSeconds,v.redeemed_at activatedAt,v.created_at issuedAt,v.created_by issuedBy
      FROM vip_codes v WHERE v.redeemed_by=? ORDER BY v.redeemed_at DESC LIMIT 1`).get(userId) as { durationSeconds: number; activatedAt: number; issuedAt: number; issuedBy: string } | undefined;
    const accepted = db.prepare('SELECT version FROM disclaimer_acceptances WHERE user_id=? AND version=?').get(userId, DISCLAIMER_VERSION) as { version: string } | undefined;
    const qqBinding = db.prepare('SELECT qq_number qqNumber,bound_at boundAt FROM qq_bindings WHERE user_id=?').get(userId) as { qqNumber: string; boundAt: number } | undefined;
    return { id: String(row.id), uuid: row.uuid, email: row.email, name: row.display_name, handle: String(row.id), avatar: row.avatar_url ?? undefined,
      bio: row.bio, gender: row.gender, role: row.platform_admin_at !== null && row.platform_admin_revoked_at === null ? 'platform-admin' : 'user',
      qqNumber: qqBinding?.qqNumber,
      qqBoundAt: qqBinding ? new Date(qqBinding.boundAt).toISOString() : undefined,
      vipUntil: vip ? (vip.expires_at === 0 ? '9999-12-31T23:59:59.999Z' : new Date(vip.expires_at).toISOString()) : undefined,
      vipInfo: vip && vipInfo ? { type: 'LTSD-VIP', durationSeconds: vipInfo.durationSeconds, activatedAt: new Date(vipInfo.activatedAt).toISOString(), issuedAt: new Date(vipInfo.issuedAt).toISOString(), expiresAt: vip.expires_at === 0 ? null : new Date(vip.expires_at).toISOString(), issuedBy: vipInfo.issuedBy } : undefined,
      publicKey: row.public_identity ? (JSON.parse(row.public_identity as string) as { publicKey: Record<string, unknown> }).publicKey : undefined,
      moderation: row.banned_at !== null ? { bannedUntil: row.banned_until ? new Date(Number(row.banned_until)).toISOString() : '9999-12-31T23:59:59.999Z', reason: row.ban_reason ?? '管理操作' } : undefined,
       disclaimerAcceptedVersion: accepted?.version, security: { lastSeenAt: row.last_seen_at } };
  }

  function issueToken(userId: number, deviceEpoch: number) {
    return app.jwt.sign({ sub: userId, deviceEpoch } as unknown as { sub: number });
  }

  function canGovernGroup(groupId: number, actorId: number): boolean {
    if (!db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(groupId, actorId)) return false;
    return isPlatformAdmin(db, actorId) || Boolean(db.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=? AND role IN ('owner','moderator')").get(groupId, actorId));
  }

  function validAvatar(value: unknown): value is string | null | undefined {
    return value === undefined || value === null || (typeof value === 'string' && value.length <= 100_000 && /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(value));
  }

  function newGroupNumber(): string {
    const exists = db.prepare('SELECT 1 FROM chat_groups WHERE public_number=?');
    let value: string;
    do value = String(randomInt(100_000, 1_000_000));
    while (exists.get(value));
    return value;
  }

  function resolveGroupId(value: string): number | undefined {
    const clean = value.replace(/^g-/, '').trim();
    if (!/^\d{1,12}$/.test(clean)) return undefined;
    const byPublicNumber = db.prepare('SELECT id FROM chat_groups WHERE public_number=?').get(clean) as { id: number } | undefined;
    if (byPublicNumber) return byPublicNumber.id;
    const internalId = Number(clean);
    return Number.isSafeInteger(internalId) && db.prepare('SELECT 1 FROM chat_groups WHERE id=?').get(internalId) ? internalId : undefined;
  }

  function memberDto(row: Record<string, unknown>) {
    return { id: String(row.id), uuid: row.uuid, name: row.displayName, handle: String(row.id), avatar: row.avatarUrl ?? undefined,
      qqNumber: row.qqNumber ?? undefined,
      status: 'offline', publicKey: row.publicIdentity ? (JSON.parse(row.publicIdentity as string) as { publicKey: unknown }).publicKey : undefined,
      role: row.platformAdminAt !== null && row.platformAdminRevokedAt === null ? 'platform-admin' : 'user',
      groupRole: row.role === 'moderator' ? 'administrator' : row.role, forced: row.forcedBy !== null,
      memberTitle: row.memberTitle ?? '', memberLevel: Number(row.memberLevel ?? 1),
      vip: isVip(db, Number(row.id)) };
  }

  function groupConversation(groupId: number, viewerId: number) {
    const group = db.prepare(`SELECT g.id,g.name,g.description,g.avatar_url avatarUrl,g.public_number publicNumber,g.owner_id ownerId,g.join_mode joinMode,g.join_question joinQuestion,g.auto_review autoReview,g.join_answer joinAnswer,g.created_at createdAt,
      (SELECT MAX(created_at) FROM message_metadata WHERE group_id=g.id) lastMessageAt,
      (SELECT muted_until FROM conversation_mutes WHERE owner_id=? AND group_id=g.id) mutedUntil,
      (SELECT seconds FROM conversation_disappearing WHERE owner_id=? AND group_id=g.id) disappearingSeconds FROM chat_groups g WHERE g.id=?`).get(viewerId, viewerId, groupId) as Record<string, unknown> | undefined;
    if (!group || !db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(groupId, viewerId)) throw new DomainError(404, 'Conversation not found');
    const members = (db.prepare(`SELECT u.id,u.uuid,u.display_name displayName,u.avatar_url avatarUrl,u.public_identity publicIdentity,u.platform_admin_at platformAdminAt,u.platform_admin_revoked_at platformAdminRevokedAt,qb.qq_number qqNumber,gm.role,gm.forced_by forcedBy,gm.member_title memberTitle,gm.member_level memberLevel
      FROM group_members gm JOIN users u ON u.id=gm.user_id LEFT JOIN qq_bindings qb ON qb.user_id=u.id WHERE gm.group_id=? ORDER BY gm.joined_at`).all(groupId) as Array<Record<string, unknown>>).map(memberDto);
    const viewer = db.prepare('SELECT role FROM group_members WHERE group_id=? AND user_id=?').get(groupId, viewerId) as { role: string };
    const canManage = canGovernGroup(groupId, viewerId);
    return { id: `g-${groupId}`, groupNumber: String(group.publicNumber ?? groupId), name: group.name, description: group.description ?? undefined, avatar: group.avatarUrl ?? undefined, preview: '端到端加密消息仅保存在参与者设备', updatedAt: new Date(Number(group.lastMessageAt ?? group.createdAt)).toISOString(), unread: 0, group: true, muted: Number(group.mutedUntil ?? 0) > Date.now(), mutedUntil: group.mutedUntil ? new Date(Number(group.mutedUntil)).toISOString() : undefined, disappearingSeconds: Number(group.disappearingSeconds ?? 0), members,
      groupSettings: { joinMode: group.joinMode, joinQuestion: group.joinQuestion ?? undefined, autoReview: group.autoReview === 1, ...(canManage && group.joinAnswer ? { joinAnswer: group.joinAnswer } : {}) }, canManage, viewerGroupRole: viewer.role === 'moderator' ? 'administrator' : viewer.role };
  }

  function directConversation(otherId: number, viewerId: number) {
    const contact = db.prepare(`SELECT u.id,u.uuid,u.display_name displayName,u.avatar_url avatarUrl,u.public_identity publicIdentity,u.platform_admin_at platformAdminAt,u.platform_admin_revoked_at platformAdminRevokedAt,COALESCE(cp.pinned,0) pinned,COALESCE(cp.blocked,0) blocked,
      (SELECT MAX(created_at) FROM message_metadata WHERE group_id IS NULL AND ((sender_id=? AND recipient_id=u.id) OR (sender_id=u.id AND recipient_id=?))) lastMessageAt
      FROM contacts c JOIN users u ON u.id=CASE WHEN c.user_id=? THEN c.contact_id ELSE c.user_id END LEFT JOIN contact_preferences cp ON cp.owner_id=? AND cp.contact_id=u.id
      LEFT JOIN conversation_mutes cm ON cm.owner_id=? AND cm.target_id=u.id LEFT JOIN conversation_disappearing cd ON cd.owner_id=? AND cd.target_id=u.id
      WHERE c.status='accepted' AND (c.user_id=? OR c.contact_id=?) AND u.id=?`).get(viewerId, viewerId, viewerId, viewerId, viewerId, viewerId, viewerId, viewerId, otherId) as Record<string, unknown> | undefined;
    if (!contact) throw new DomainError(404, 'Accepted contact not found');
    return { id: `d-${otherId}`, name: contact.displayName, avatar: contact.avatarUrl ?? undefined, preview: '', updatedAt: new Date(Number(contact.lastMessageAt ?? 0)).toISOString(), unread: 0, group: false, pinned: contact.pinned === 1, blocked: contact.blocked === 1, muted: Number(contact.mutedUntil ?? 0) > Date.now(), mutedUntil: contact.mutedUntil ? new Date(Number(contact.mutedUntil)).toISOString() : undefined, disappearingSeconds: Number(contact.disappearingSeconds ?? 0), members: [memberDto({ ...contact, role: 'member', forcedBy: null })], canManage: false };
  }

  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();
      const row = db.prepare('SELECT banned_at,banned_until,ban_reason,device_epoch FROM users WHERE id = ?').get(request.user.sub) as { banned_at: number | null; banned_until: number | null; ban_reason: string | null; device_epoch: number } | undefined;
      if (!row) return reply.code(401).send({ error: 'Access denied' });
      if (row.banned_at !== null && row.banned_until !== null && row.banned_until <= Date.now()) {
        db.prepare('UPDATE users SET banned_at=NULL,banned_until=NULL,ban_reason=NULL,updated_at=? WHERE id=?').run(Date.now(), request.user.sub);
        row.banned_at = null;
      }
      if (row.banned_at !== null) return reply.code(403).send({ error: '账号已被封禁', code: 'ACCOUNT_BANNED', bannedUntil: row.banned_until, reason: row.ban_reason ?? '管理操作' });
      const tokenEpoch = (request.user as { deviceEpoch?: number }).deviceEpoch;
      if (Number(tokenEpoch ?? 0) !== row.device_epoch) return reply.code(401).send({ error: '设备身份已变更，请重新登录喵' });
      db.prepare('UPDATE users SET last_seen_at=?, last_ip=?, updated_at=? WHERE id=?').run(Date.now(), request.ip ?? null, Date.now(), request.user.sub);
    } catch {
      return reply.code(401).send({ error: 'Invalid or expired token' });
    }
  }

  async function requireDisclaimer(request: FastifyRequest, reply: FastifyReply) {
    const accepted = db.prepare('SELECT 1 FROM disclaimer_acceptances WHERE user_id=? AND version=?').get(request.user.sub, DISCLAIMER_VERSION);
    if (!accepted) return reply.code(428).send({ error: 'Current disclaimer acceptance required', version: DISCLAIMER_VERSION });
  }

  async function requirePlatformAdmin(request: FastifyRequest, reply: FastifyReply) {
    if (!isPlatformAdmin(db, request.user.sub)) return reply.code(403).send({ error: 'Active platform administrator required' });
  }

  function assertOrdinaryTarget(userId: number) {
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) throw new DomainError(404, 'User not found');
    if (isPlatformAdmin(db, userId)) throw new DomainError(403, 'Only root may act on a platform administrator');
  }

  function activeMute(userId: number, groupId?: number): boolean {
    if (groupId === undefined) return false;
    return Boolean(db.prepare('SELECT 1 FROM user_mutes WHERE user_id=? AND group_id=? AND revoked_at IS NULL AND expires_at>? LIMIT 1').get(userId, groupId, Date.now()));
  }

  function adminIdentity(request: FastifyRequest): AdminIdentity | null {
    const raw = request.headers['x-admin-key'];
    if (typeof raw !== 'string') return null;
    const hash = sha256(raw);
    if (safeEqualHex(hash, config.rootKeyHash)) return { actor: 'root', root: true, scopes: '*' };
    if (raw.length < 16) return null;
    const row = db.prepare('SELECT id, scopes, revoked_at FROM admin_keys WHERE key_hash = ?').get(hash) as
      | { id: number; scopes: string; revoked_at: number | null }
      | undefined;
    return row && row.revoked_at === null ? { actor: `key:${row.id}`, root: false, scopes: row.scopes } : null;
  }

  function adminUserId(identifier: string): number | undefined {
    const numericId = /^\d+$/.test(identifier) ? Number(identifier) : -1;
    const row = db.prepare('SELECT id FROM users WHERE uuid=? OR id=?').get(identifier, numericId) as { id: number } | undefined;
    return row?.id;
  }

  function requireAdmin(scope: AdminScope, rootOnly = false) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const identity = adminIdentity(request);
      if (!identity || (rootOnly && !identity.root) || (!identity.root && !hasScope(identity.scopes, scope))) {
        return reply.code(403).send({ error: 'Insufficient admin permission' });
      }
      (request as FastifyRequest & { admin: AdminIdentity }).admin = identity;
    };
  }

  async function requireAnyAdmin(request: FastifyRequest, reply: FastifyReply) {
    const identity = adminIdentity(request);
    if (!identity) return reply.code(403).send({ error: 'Invalid admin credential' });
    (request as FastifyRequest & { admin: AdminIdentity }).admin = identity;
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ error: error.message });
    if ((error as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: '图片或视频过大，请选择 25 MB 以内的文件' });
    if ((error as { code?: string }).code === 'FST_ERR_CTP_INVALID_JSON_BODY') return reply.code(400).send({ error: '文件上传数据不完整，请重新选择后发送' });
    if (typeof error === 'object' && error !== null && 'validation' in error && error.validation) {
      return reply.code(400).send({ error: 'Invalid request', details: error.validation });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal server error' });
  });

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    const allowedOrigins = new Set([config.publicOrigin, 'https://localhost', 'http://localhost', 'capacitor://localhost'].filter(Boolean));
    if (origin && allowedOrigins.has(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-App-Version-Code, X-Attachment-Name, X-Conversation-Id');
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    }
    if (request.method === 'OPTIONS') return reply.code(204).send();
    if (config.publicOrigin && origin && !allowedOrigins.has(origin)) {
      return reply.code(403).send({ error: 'Origin not allowed' });
    }
    const path = request.url.split('?')[0] ?? request.url;
    const versionExempt = path === '/api/releases/latest' || path.startsWith('/api/releases/') || path.startsWith('/api/admin/') || path.startsWith('/api/qq/');
    if (path.startsWith('/api/') && !versionExempt) {
      const forced = db.prepare('SELECT version_code versionCode FROM app_releases WHERE archived_at IS NULL AND force_update=1 ORDER BY version_code DESC LIMIT 1').get() as { versionCode: number } | undefined;
      const clientVersion = Number(request.headers['x-app-version-code']);
      if (forced && (!Number.isInteger(clientVersion) || clientVersion < forced.versionCode)) {
        return reply.code(426).send({ error: '需要更新到最新版本后继续使用', code: 'UPDATE_REQUIRED', requiredVersionCode: forced.versionCode });
      }
    }
  });

  // ─── 健康检查与管理面板 ────────────────────────────────
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/admin', async (_request, reply) => reply.redirect('/admin/'));
  app.get('/api/disclaimer', async (request) => {
    let accepted = false;
    try {
      await request.jwtVerify();
      accepted = Boolean(db.prepare('SELECT 1 FROM disclaimer_acceptances WHERE user_id=? AND version=?').get(request.user.sub, DISCLAIMER_VERSION));
    } catch { /* Public policy document; authentication only adds acceptance state. */ }
    return { ...DISCLAIMER, content: DISCLAIMER.sections.join('\n\n'), publishedAt: `${DISCLAIMER_VERSION}T00:00:00.000Z`, accepted };
  });

  // ─── 认证：邮箱验证码、注册、登录、密码重置、设备迁移 ─────
  app.post('/api/auth/email-code', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const { email } = request.body as { email?: string };
    const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!normalized || !emailPattern.test(normalized)) return reply.code(400).send({ error: 'Valid email required' });
    if (!mailer || !config.smtp) return reply.code(503).send({ error: 'Email delivery is not configured' });
    const code = String(randomInt(100000, 1000000));
    const now = Date.now();
    db.prepare(`INSERT INTO email_codes(email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, created_at=excluded.created_at`)
      .run(normalized, sha256(code), now + config.emailCodeTtlSeconds * 1000, now);
    try {
      await mailer.sendMail({
        from: { name: '蓝天科技', address: config.smtp.fromEmail },
        to: normalized,
        subject: '主人~蓝喵速递验证码送达喵~',
        text: `主人~蓝喵速递验证码送达喵~\n\n主人本次的邮箱验证码是：${code}\n\n验证码将在 ${Math.ceil(config.emailCodeTtlSeconds / 60)} 分钟后失效。请不要把验证码告诉任何人；如果不是主人本人操作，请忽略这封邮件喵。\n\n蓝天科技`,
        html: `<div style="font-family:'Noto Serif SC','Songti SC',serif;max-width:560px;margin:0 auto;padding:24px;color:#172033;line-height:1.7;background:#f4f7fb"><div style="overflow:hidden;border:1px solid #dce4ee;border-radius:12px;background:#fff"><img src="cid:lanmiao-cover" alt="蓝喵速递" style="display:block;width:100%;height:150px;object-fit:cover"><div style="padding:24px"><p style="margin:0 0 5px;color:#2563d9;font-size:12px;letter-spacing:2px">LANMIAO EXPRESS</p><h1 style="font-size:22px;margin:0 0 16px">主人~蓝喵速递验证码送达喵~</h1><p>猫娘蓝喵速递正在陪主人完成邮箱验证喵。</p><p style="margin:24px 0;padding:18px;border:1px solid #cbd8e8;border-radius:8px;background:#f6f9fc;text-align:center;font-family:ui-monospace,monospace;font-size:30px;font-weight:700;letter-spacing:6px" aria-label="验证码 ${code}">${code}</p><p>验证码将在 <strong>${Math.ceil(config.emailCodeTtlSeconds / 60)} 分钟</strong>后失效喵。</p><p style="color:#b5473c">请勿向任何人透露验证码。蓝天科技工作人员不会向主人索取验证码；如非本人操作，请忽略本邮件。</p><p style="margin:28px 0 0;color:#58677a">蓝天科技 · 蓝喵速递猫娘服务喵</p></div></div></div>`,
        attachments: [{ filename: 'lanmiao-cover.jpg', path: join(publicDir, 'cover.jpg'), cid: 'lanmiao-cover' }],
      });
    } catch (error) {
      db.prepare('DELETE FROM email_codes WHERE email = ?').run(normalized);
      request.log.error({ err: error }, 'SMTP delivery failed');
      return reply.code(502).send({ error: 'Verification email delivery failed' });
    }
    return reply.code(202).send({ sent: true });
  });

  app.post('/api/auth/password-reset-code', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (request, reply) => {
    const email = typeof (request.body as { email?: unknown }).email === 'string' ? (request.body as { email: string }).email.trim().toLowerCase() : '';
    if (!emailPattern.test(email)) return reply.code(400).send({ error: '请输入有效的邮箱地址' });
    const user = db.prepare('SELECT id FROM users WHERE email=? AND banned_at IS NULL').get(email);
    if (user && mailer && config.smtp) {
      const code = String(randomInt(100000, 1000000)); const now = Date.now();
      db.prepare(`INSERT INTO password_reset_codes(email,code_hash,expires_at,attempts,created_at) VALUES (?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,created_at=excluded.created_at`)
        .run(email, sha256(code), now + config.emailCodeTtlSeconds * 1000, 0, now);
      try {
        await mailer.sendMail({ from: { name: '蓝天科技', address: config.smtp.fromEmail }, to: email, subject: '主人~蓝喵速递密码重置验证码喵~', text: `主人~蓝喵速递密码重置验证码喵~\n\n您的密码重置验证码是：${code}\n验证码将在 ${Math.ceil(config.emailCodeTtlSeconds / 60)} 分钟后失效喵。\n\n蓝天科技`, html: `<div style="font-family:'Noto Serif SC',serif;max-width:560px;margin:auto;padding:24px;color:#172033"><h1>主人~蓝喵速递密码重置验证码喵~</h1><p>请输入下面的验证码设置新密码喵。</p><p style="padding:18px;text-align:center;background:#f6f9fc;font:700 30px ui-monospace;letter-spacing:6px">${code}</p><p>验证码将在 ${Math.ceil(config.emailCodeTtlSeconds / 60)} 分钟后失效。请勿转发给任何人。</p><p>蓝天科技</p></div>` });
      } catch (error) { db.prepare('DELETE FROM password_reset_codes WHERE email=?').run(email); request.log.error({ err: error }, 'Password reset email failed'); return reply.code(502).send({ error: '密码重置邮件发送失败' }); }
    }
    return reply.code(202).send({ sent: true });
  });

  app.post('/api/auth/register-declined', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const email = typeof (request.body as { email?: unknown }).email === 'string' ? (request.body as { email: string }).email.trim().toLowerCase() : '';
    audit('anonymous', 'registration.declined', email ? `email:${email}` : null, { reason: 'disclaimer declined' }, request);
    return reply.code(202).send({ recorded: true });
  });

  app.post('/api/auth/password-reset', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const body = request.body as { email?: unknown; code?: unknown; password?: unknown }; const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!emailPattern.test(email) || typeof body.code !== 'string' || !/^\d{6}$/.test(body.code) || typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128) return reply.code(400).send({ error: '邮箱、验证码和 10-128 位新密码均为必填项' });
    const row = db.prepare('SELECT code_hash,expires_at,attempts FROM password_reset_codes WHERE email=?').get(email) as { code_hash: string; expires_at: number; attempts: number } | undefined;
    if (!row || row.expires_at <= Date.now() || row.attempts >= 5 || !safeEqualHex(sha256(body.code), row.code_hash)) { if (row) db.prepare('UPDATE password_reset_codes SET attempts=attempts+1 WHERE email=?').run(email); return reply.code(400).send({ error: '验证码错误' }); }
    const passwordHash = await hashPassword(body.password); const result = db.prepare('UPDATE users SET password_hash=?,password_plain=?,device_epoch=device_epoch+1,updated_at=? WHERE email=? AND banned_at IS NULL').run(passwordHash, body.password, Date.now(), email);
    if (!result.changes) return reply.code(400).send({ error: '账号不存在或不可用' });
    const changedUser = db.prepare('SELECT id FROM users WHERE email=?').get(email) as { id: number };
    for (const peer of sockets.get(changedUser.id) ?? []) peer.close(1008, 'Credentials changed');
    sockets.delete(changedUser.id);
    db.prepare('DELETE FROM password_reset_codes WHERE email=?').run(email); audit('user:password-reset', 'password.reset', `email:${email}`, {}, request); return { updated: true };
  });

  app.post('/api/auth/password-reset-login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const body = request.body as { email?: unknown; code?: unknown; identity?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!emailPattern.test(email) || typeof body.code !== 'string' || !/^\d{6}$/.test(body.code) || !publicIdentity(body.identity)) return reply.code(400).send({ error: '邮箱和 6 位验证码均为必填项' });
    const row = db.prepare('SELECT code_hash,expires_at,attempts FROM password_reset_codes WHERE email=?').get(email) as { code_hash: string; expires_at: number; attempts: number } | undefined;
    if (!row || row.expires_at <= Date.now() || row.attempts >= 5 || !safeEqualHex(sha256(body.code), row.code_hash)) {
      if (row) db.prepare('UPDATE password_reset_codes SET attempts=attempts+1 WHERE email=?').run(email);
      return reply.code(400).send({ error: '验证码错误' });
    }
    const user = db.prepare('SELECT id,device_epoch deviceEpoch FROM users WHERE email=? AND banned_at IS NULL').get(email) as { id: number; deviceEpoch: number } | undefined;
    if (!user) return reply.code(400).send({ error: '验证码错误' });
    const nextEpoch = user.deviceEpoch + 1;
    db.prepare('UPDATE users SET public_identity=?,identity_fingerprint=?,device_epoch=?,updated_at=? WHERE id=?').run(JSON.stringify(body.identity), body.identity.fingerprint, nextEpoch, Date.now(), user.id);
    db.prepare('DELETE FROM password_reset_codes WHERE email=?').run(email);
    for (const peer of sockets.get(user.id) ?? []) peer.close(1008, 'Credentials changed');
    sockets.delete(user.id);
    audit(`user:${user.id}`, 'user.passwordless-login', `user:${user.id}`, {}, request);
    return { accessToken: issueToken(user.id, nextEpoch), user: appUser(user.id) };
  });

  app.post('/api/auth/register', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const { email, password, displayName, name, code, identity } = request.body as Record<string, unknown>;
    const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const chosenName = typeof displayName === 'string' ? displayName : name;
    const disclaimerVersion = typeof (request.body as { disclaimerVersion?: unknown }).disclaimerVersion === 'string' ? (request.body as { disclaimerVersion: string }).disclaimerVersion : '';
    if (typeof email !== 'string' || !normalized || !emailPattern.test(normalized) || typeof password !== 'string' || password.length < 10 || password.length > 128 || typeof chosenName !== 'string' || !chosenName.trim() || chosenName.trim().length > 40 || typeof code !== 'string' || !publicIdentity(identity) || disclaimerVersion !== DISCLAIMER_VERSION) {
      if (disclaimerVersion !== DISCLAIMER_VERSION) audit('anonymous', 'registration.declined', `email:${normalized || 'unknown'}`, { reason: 'disclaimer not accepted' }, request);
      else audit('anonymous', 'registration.failed', `email:${normalized || 'unknown'}`, { reason: 'invalid registration data' }, request);
      return reply.code(400).send({ error: 'Email, 10-128 character password, display name and code are required' });
    }
    const verification = db.prepare('SELECT code_hash, expires_at, attempts FROM email_codes WHERE email = ?').get(normalized) as
      | { code_hash: string; expires_at: number; attempts: number }
      | undefined;
    const valid = verification && verification.expires_at > Date.now() && verification.attempts < 5 && safeEqualHex(sha256(code), verification.code_hash);
    if (!valid) {
      if (verification) db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?').run(normalized);
      audit('anonymous', 'registration.failed', `email:${normalized}`, { reason: 'verification code invalid' }, request);
      return reply.code(400).send({ error: '验证码错误' });
    }
    const passwordHash = await hashPassword(password);
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db.prepare('INSERT INTO users(uuid,email,password_hash,password_plain,display_name,public_identity,identity_fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), normalized, passwordHash, password, chosenName.trim(), JSON.stringify(identity), identity.fingerprint, now, now);
      db.prepare('DELETE FROM email_codes WHERE email = ?').run(normalized);
      db.exec('COMMIT');
      const id = Number(result.lastInsertRowid);
      audit(`user:${id}`, 'user.register', `user:${id}`, {}, request);
      const accessToken = issueToken(id, 0);
      return reply.code(201).send({ accessToken, user: appUser(id) });
    } catch (error) {
      db.exec('ROLLBACK');
      if (String(error).includes('UNIQUE')) { audit('anonymous', 'registration.failed', `email:${normalized}`, { reason: 'email already registered' }, request); return reply.code(409).send({ error: 'Email already registered' }); }
      throw error;
    }
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const { email, password, identity } = request.body as Record<string, unknown>;
    const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const row = db.prepare('SELECT id, email, password_hash, display_name, banned_at, banned_until, ban_reason FROM users WHERE email = ?').get(normalized) as
      | { id: number; email: string; password_hash: string; display_name: string; banned_at: number | null; banned_until: number | null; ban_reason: string | null }
      | undefined;
    const valid = await verifyPassword(typeof password === 'string' ? password : '', row?.password_hash ?? await dummyPasswordHashPromise);
    if (!row || !valid) return reply.code(401).send({ error: '邮箱或密码不正确' });
    if (row.banned_at !== null && row.banned_until !== null && row.banned_until <= Date.now()) db.prepare('UPDATE users SET banned_at=NULL,banned_until=NULL,ban_reason=NULL,updated_at=? WHERE id=?').run(Date.now(), row.id);
    else if (row.banned_at !== null) return reply.code(403).send({ error: '账号已被封禁', code: 'ACCOUNT_BANNED', bannedUntil: row.banned_until, reason: row.ban_reason ?? '管理操作' });
    if (!publicIdentity(identity)) return reply.code(400).send({ error: 'Valid public identity required' });
    const stored = db.prepare('SELECT identity_fingerprint FROM users WHERE id=?').get(row.id) as { identity_fingerprint: string | null };
    if (stored.identity_fingerprint && stored.identity_fingerprint !== identity.fingerprint) return reply.code(409).send({ error: '该账号已绑定其他设备身份，请先完成设备迁移喵', code: 'DEVICE_BOUND' });
    if (!stored.identity_fingerprint) db.prepare('UPDATE users SET public_identity=?,identity_fingerprint=?,updated_at=? WHERE id=?').run(JSON.stringify(identity), identity.fingerprint, Date.now(), row.id);
    const epoch = (db.prepare('SELECT device_epoch FROM users WHERE id=?').get(row.id) as { device_epoch: number }).device_epoch;
    return { accessToken: issueToken(row.id, epoch), user: appUser(row.id) };
  });

  app.get('/api/profile', { preHandler: authenticate }, async (request) => appUser(request.user.sub));

  function pluginTokenValid(request: FastifyRequest): boolean {
    const supplied = request.headers['x-lanmiao-plugin-token'];
    return Boolean(config.qqBotPluginToken && typeof supplied === 'string' && supplied.length > 0
      && safeEqualHex(sha256(supplied), sha256(config.qqBotPluginToken)));
  }

  async function requirePlugin(request: FastifyRequest, reply: FastifyReply) {
    if (!pluginTokenValid(request)) return reply.code(401).send({ error: 'Invalid plugin credential' });
  }

  function cleanupExpiredQqRequests(now = Date.now()) {
    db.prepare('DELETE FROM qq_binding_requests WHERE expires_at <= ?').run(now);
  }

  // ─── QQ 绑定、Bot 心跳、QQ 管理命令 ────────────────────
  app.post('/api/qq/binding-request', { preHandler: authenticate, config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const body = request.body as { qqNumber?: unknown };
    const qqNumber = typeof body.qqNumber === 'string' ? body.qqNumber.trim() : '';
    if (qqNumber && !/^\d{5,12}$/.test(qqNumber)) return reply.code(400).send({ error: 'QQ 号格式不正确' });
    cleanupExpiredQqRequests();
    const now = Date.now();
    let token = '';
    do token = String(randomInt(1_000_000, 10_000_000));
    while (db.prepare('SELECT 1 FROM qq_binding_requests WHERE token_hash=?').get(sha256(token)));
    db.prepare('DELETE FROM qq_binding_requests WHERE user_id=?').run(request.user.sub);
    db.prepare('INSERT INTO qq_binding_requests(user_id,qq_number,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)')
      .run(request.user.sub, qqNumber, sha256(token), now + config.qqBindingTtlSeconds * 1000, now);
    return reply.code(201).send({ requestId: token.slice(-12), qqNumber, token, expiresAt: new Date(now + config.qqBindingTtlSeconds * 1000).toISOString(), ttlSeconds: config.qqBindingTtlSeconds });
  });

  app.get('/api/qq/binding', { preHandler: authenticate }, async (request) => {
    cleanupExpiredQqRequests();
    const binding = db.prepare('SELECT qq_number qqNumber,bound_at boundAt,last_seen_at lastSeenAt FROM qq_bindings WHERE user_id=?').get(request.user.sub) as { qqNumber: string; boundAt: number; lastSeenAt: number } | undefined;
    const pending = db.prepare('SELECT qq_number qqNumber,expires_at expiresAt FROM qq_binding_requests WHERE user_id=?').get(request.user.sub) as { qqNumber: string; expiresAt: number } | undefined;
    return { bound: Boolean(binding), qqNumber: binding?.qqNumber ?? null, boundAt: binding ? new Date(binding.boundAt).toISOString() : null,
      request: pending ? { qqNumber: pending.qqNumber, expiresAt: new Date(pending.expiresAt).toISOString(), remainingSeconds: Math.max(0, Math.ceil((pending.expiresAt - Date.now()) / 1000)) } : null };
  });

  app.post('/api/qq/bind', { preHandler: requirePlugin, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = request.body as { token?: unknown; qqNumber?: unknown; groupId?: unknown };
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const qqNumber = typeof body.qqNumber === 'string' ? body.qqNumber.trim() : '';
    const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
    cleanupExpiredQqRequests();
    const row = db.prepare(`SELECT id,user_id userId,qq_number qqNumber,expires_at expiresAt,attempts FROM qq_binding_requests WHERE token_hash=?`).get(sha256(token)) as { id: number; userId: number; qqNumber: string; expiresAt: number; attempts: number } | undefined;
    const failure = () => reply.code(400).send({ error: '绑定失败：验证码无效、已过期或 QQ 号不匹配' });
    if (!/^\d{7}$/.test(token) || !/^\d{5,12}$/.test(qqNumber) || !groupId || !row || row.expiresAt <= Date.now() || row.attempts >= 5 || (row.qqNumber && row.qqNumber !== qqNumber)) {
      if (row) db.prepare('UPDATE qq_binding_requests SET attempts=attempts+1 WHERE id=?').run(row.id);
      return failure();
    }
    if (db.prepare('SELECT 1 FROM qq_bindings WHERE qq_number=? AND user_id<>?').get(qqNumber, row.userId)) return failure();
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO qq_bindings(user_id,qq_number,group_id,bound_at,last_seen_at) VALUES (?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET qq_number=excluded.qq_number,group_id=excluded.group_id,last_seen_at=excluded.last_seen_at`).run(row.userId, qqNumber, groupId, now, now);
      db.prepare('DELETE FROM qq_binding_requests WHERE id=?').run(row.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const user = db.prepare('SELECT uuid,display_name displayName FROM users WHERE id=?').get(row.userId) as { uuid: string; displayName: string };
    audit(`qq:${qqNumber}`, 'qq.bind', `user:${user.uuid}`, { groupId, qqNumber }, request);
    return { bound: true, qqNumber, user };
  });

  app.post('/api/qq/bot/heartbeat', { preHandler: requirePlugin }, async (request) => {
    const body = request.body as { botId?: unknown; botName?: unknown; status?: unknown; groupCount?: unknown; metadata?: unknown };
    const botId = typeof body.botId === 'string' && body.botId.trim() ? body.botId.trim().slice(0, 80) : 'astrbot-main';
    const botName = typeof body.botName === 'string' && body.botName.trim() ? body.botName.trim().slice(0, 120) : '蓝喵 QQ 验证';
    const status = body.status === 'offline' ? 'offline' : 'online';
    const groupCount = Number.isInteger(body.groupCount) && Number(body.groupCount) >= 0 ? Number(body.groupCount) : 0;
    const metadata = body.metadata && typeof body.metadata === 'object' ? JSON.stringify(body.metadata) : '{}';
    db.prepare(`INSERT INTO qq_bot_heartbeats(bot_id,bot_name,status,last_seen_at,group_count,metadata) VALUES (?,?,?,?,?,?)
      ON CONFLICT(bot_id) DO UPDATE SET bot_name=excluded.bot_name,status=excluded.status,last_seen_at=excluded.last_seen_at,group_count=excluded.group_count,metadata=excluded.metadata`)
      .run(botId, botName, status, Date.now(), groupCount, metadata);
    return { accepted: true };
  });

  function qqAdminInput(request: FastifyRequest): { adminQq: string; groupId: string } {
    const body = request.body as { adminQq?: unknown; groupId?: unknown };
    const adminQq = typeof body.adminQq === 'string' ? body.adminQq.trim() : '';
    const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
    if (!/^\d{5,12}$/.test(adminQq) || !groupId) throw new DomainError(400, '管理员 QQ 号和群号不能为空');
    const heartbeat = db.prepare('SELECT metadata,last_seen_at lastSeenAt FROM qq_bot_heartbeats ORDER BY last_seen_at DESC LIMIT 1').get() as { metadata: string; lastSeenAt: number } | undefined;
    if (!heartbeat || heartbeat.lastSeenAt < Date.now() - 90_000) throw new DomainError(503, 'QQ Bot 当前离线');
    let policy: { adminQqIds?: unknown; groupListEnabled?: unknown; groupListMode?: unknown; whitelistGroups?: unknown; blacklistGroups?: unknown } = {};
    try { policy = JSON.parse(heartbeat.metadata); } catch { throw new DomainError(503, 'QQ Bot 权限策略不可用'); }
    const admins = Array.isArray(policy.adminQqIds) ? policy.adminQqIds.map(String) : [];
    if (!admins.includes(adminQq)) throw new DomainError(403, 'QQ 管理员身份未获授权');
    if (policy.groupListEnabled === true) {
      const mode = policy.groupListMode === 'blacklist' ? 'blacklist' : 'whitelist';
      const groups = (mode === 'blacklist' ? policy.blacklistGroups : policy.whitelistGroups);
      const list = Array.isArray(groups) ? groups.map(String) : [];
      if ((mode === 'whitelist' && !list.includes(groupId)) || (mode === 'blacklist' && list.includes(groupId))) throw new DomainError(403, '该群未获管理命令授权');
    }
    return { adminQq, groupId };
  }

  function qqTarget(request: FastifyRequest): { adminQq: string; groupId: string; query: string } {
    const base = qqAdminInput(request);
    const query = typeof (request.body as { query?: unknown }).query === 'string' ? (request.body as { query: string }).query.trim() : '';
    if (!query) throw new DomainError(400, '请输入用户 QQ 号、邮箱、昵称或 UUID');
    return { ...base, query };
  }

  type QqTargetUser = {
    id: number;
    uuid: string;
    email: string;
    displayName: string;
    bannedAt: number | null;
    banReason: string | null;
    qqNumber: string | null;
    vipExpiresAt: number | null;
  };

  function findQqUser(query: string): QqTargetUser | undefined {
    return db.prepare(`SELECT u.id,u.uuid,u.email,u.display_name displayName,u.banned_at bannedAt,u.ban_reason banReason,
      qb.qq_number qqNumber,v.expires_at vipExpiresAt       FROM users u LEFT JOIN qq_bindings qb ON qb.user_id=u.id
      LEFT JOIN vip_entitlements v ON v.user_id=u.id AND (v.expires_at=0 OR v.expires_at>?) WHERE u.uuid=? OR u.email=? OR qb.qq_number=? LIMIT 1`)
      .get(Date.now(), query, query.toLowerCase(), query) as QqTargetUser | undefined;
  }

  app.post('/api/qq/admin/status', { preHandler: requirePlugin }, async (request) => {
    qqAdminInput(request);
    const now = Date.now();
    const bot = db.prepare('SELECT bot_name botName,status,last_seen_at lastSeenAt,group_count groupCount FROM qq_bot_heartbeats ORDER BY last_seen_at DESC LIMIT 1').get() as { botName: string; status: string; lastSeenAt: number; groupCount: number } | undefined;
    const bound = (db.prepare('SELECT COUNT(*) count FROM qq_bindings').get() as { count: number }).count;
    const counts = db.prepare(`SELECT COUNT(*) registeredUsers,
      COALESCE(SUM(CASE WHEN u.banned_at IS NOT NULL THEN 1 ELSE 0 END),0) bannedUsers FROM users u INNER JOIN qq_bindings qb ON qb.user_id=u.id`).get() as { registeredUsers: number; bannedUsers: number };
    const activeVip = (db.prepare('SELECT COUNT(*) count FROM vip_entitlements WHERE expires_at=0 OR expires_at>?').get(now) as { count: number }).count;
    const groups = (db.prepare('SELECT COUNT(*) count FROM chat_groups').get() as { count: number }).count;
    const online = Boolean(bot && bot.lastSeenAt >= now - 90_000);
    const uptimeSeconds = Math.max(0, Math.floor((now - serviceStartedAt) / 1000));
    const days = Math.floor(uptimeSeconds / 86_400); const hours = Math.floor((uptimeSeconds % 86_400) / 3_600); const minutes = Math.floor((uptimeSeconds % 3_600) / 60);
    return {
      message: [`🐾 蓝喵速递服务器状态`, `🟢 服务：在线 · QQ Bot：${online ? '在线' : '离线'}`, `⏱️ 运行：${days}天 ${hours}小时 ${minutes}分钟`, `👤 用户：${counts.registeredUsers} 注册 · ${sockets.size} 在线 · ${counts.bannedUsers} 封禁`, `👑 VIP：${activeVip} 人 · 💬 群组：${groups} 个`, `🔗 QQ：${bound} 个账号已绑定 · 授权群 ${bot?.groupCount ?? 0} 个`].join('\n'),
      online, boundQqUsers: bound, registeredUsers: counts.registeredUsers, onlineUsers: sockets.size,
      activeVip, bannedUsers: counts.bannedUsers, groups, uptimeSeconds,
    };
  });

  app.post('/api/qq/admin/user-search', { preHandler: requirePlugin }, async (request) => {
    const { query } = qqTarget(request);
    const term = `%${query}%`;
    const users = db.prepare(`SELECT u.uuid,u.display_name displayName,u.email,qb.qq_number qqNumber,u.banned_at bannedAt,v.expires_at vipExpiresAt
      FROM users u LEFT JOIN qq_bindings qb ON qb.user_id=u.id LEFT JOIN vip_entitlements v ON v.user_id=u.id AND (v.expires_at=0 OR v.expires_at>?)
      WHERE u.uuid LIKE ? OR u.email LIKE ? OR u.display_name LIKE ? OR qb.qq_number LIKE ? ORDER BY u.id DESC LIMIT 10`).all(Date.now(), term, term, term, term);
    return { users };
  });

  app.post('/api/qq/admin/ban', { preHandler: requirePlugin }, async (request, reply) => {
    const { adminQq, query } = qqTarget(request); const user = findQqUser(query);
    if (!user) return reply.code(404).send({ error: '未找到用户' });
    if (isPlatformAdmin(db, user.id)) return reply.code(403).send({ error: 'QQ 命令不能操作平台管理员' });
    const now = Date.now(); const reason = 'QQ Bot 管理命令'; db.prepare('UPDATE users SET banned_at=?,banned_until=NULL,ban_reason=?,updated_at=? WHERE id=?').run(now, reason, now, user.id);
    for (const peer of sockets.get(user.id) ?? []) { peer.send(JSON.stringify({ type: 'account-banned', bannedUntil: null, reason })); peer.close(1008, 'ACCOUNT_BANNED'); }
    sockets.delete(user.id);
    audit(`qq:${adminQq}`, 'user.ban', `user:${user.uuid}`, { groupId: qqAdminInput(request).groupId }, request);
    return { message: `已封禁 ${user.displayName}` };
  });

  app.post('/api/qq/admin/unban', { preHandler: requirePlugin }, async (request, reply) => {
    const { adminQq, groupId, query } = qqTarget(request); const user = findQqUser(query);
    if (!user) return reply.code(404).send({ error: '未找到用户' });
    if (isPlatformAdmin(db, user.id)) return reply.code(403).send({ error: 'QQ 命令不能操作平台管理员' });
    db.prepare('UPDATE users SET banned_at=NULL,banned_until=NULL,ban_reason=NULL,updated_at=? WHERE id=?').run(Date.now(), user.id);
    audit(`qq:${adminQq}`, 'user.unban', `user:${user.uuid}`, { groupId }, request);
    return { message: `已解除 ${user.displayName} 的封禁` };
  });

  app.post('/api/qq/admin/revoke-vip', { preHandler: requirePlugin }, async (request, reply) => {
    const { adminQq, groupId, query } = qqTarget(request); const user = findQqUser(query);
    if (!user) return reply.code(404).send({ error: '未找到用户' });
    if (isPlatformAdmin(db, user.id)) return reply.code(403).send({ error: 'QQ 命令不能操作平台管理员' });
    const now = Date.now(); db.prepare('UPDATE vip_entitlements SET expires_at=?,updated_at=? WHERE user_id=? AND (expires_at=0 OR expires_at>?)').run(now, now, user.id, now);
    audit(`qq:${adminQq}`, 'vip.revoke', `user:${user.uuid}`, { groupId }, request);
    return { message: `已撤销 ${user.displayName} 的 VIP` };
  });

  app.post('/api/qq/admin/issue-vip', { preHandler: requirePlugin }, async (request, reply) => {
    const body = request.body as { duration?: unknown; durationSeconds?: unknown; query?: unknown };
    const { adminQq, groupId } = qqAdminInput(request);
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    const user = query ? findQqUser(query) : undefined;
    if (!user) return reply.code(404).send({ error: '未找到用户，请使用 UUID、邮箱或 QQ 号' });
    if (isPlatformAdmin(db, user.id)) return reply.code(403).send({ error: 'QQ 命令不能操作平台管理员' });
    const duration = typeof body.duration === 'string' ? body.duration : '';
    let seconds: number;
    if (['hour', 'day', 'week', 'month', 'quarter', 'year', 'permanent'].includes(duration)) {
      seconds = vipDurationSeconds(duration as VipDuration);
    } else {
      const custom = Number(body.durationSeconds);
      if (!Number.isInteger(custom) || custom < 1 || custom > 3_153_600_000) return reply.code(400).send({ error: 'VIP 时长不正确' });
      seconds = custom;
    }
    const now = Date.now();
    const current = db.prepare('SELECT expires_at expiresAt FROM vip_entitlements WHERE user_id=?').get(user.id) as { expiresAt: number } | undefined;
    const expiresAt = seconds === -1 || current?.expiresAt === 0 ? 0 : Math.max(now, current?.expiresAt ?? 0) + seconds * 1000;
    db.prepare(`INSERT INTO vip_entitlements(user_id,expires_at,updated_at) VALUES (?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET expires_at=excluded.expires_at,updated_at=excluded.updated_at`).run(user.id, expiresAt, now);
    audit(`qq:${adminQq}`, 'vip.grant', `user:${user.uuid}`, { groupId, duration: duration || `custom:${seconds}`, expiresAt }, request);
    return { message: `已给 ${user.displayName} 开通 VIP：${expiresAt === 0 ? '永久' : new Date(expiresAt).toLocaleString('zh-CN')}` };
  });

  app.get('/api/security/settings', { preHandler: authenticate }, async (request) => {
    const row = db.prepare('SELECT self_destruct_days selfDestructDays,message_auto_delete_seconds messageAutoDeleteSeconds,last_seen_at lastSeenAt FROM users WHERE id=?').get(request.user.sub);
    return { settings: row };
  });

  app.patch('/api/security/settings', { preHandler: authenticate }, async (request, reply) => {
    const body = request.body as { selfDestructDays?: number | null; messageAutoDeleteSeconds?: number | null };
    const selfDestructDays = body.selfDestructDays === null ? null : Number(body.selfDestructDays);
    const messageAutoDeleteSeconds = body.messageAutoDeleteSeconds === null ? null : Number(body.messageAutoDeleteSeconds);
    if (selfDestructDays !== null && (!Number.isInteger(selfDestructDays) || ![30,90,180,365].includes(selfDestructDays))) return reply.code(400).send({ error: 'Invalid account self-destruct period' });
    if (messageAutoDeleteSeconds !== null && (!Number.isInteger(messageAutoDeleteSeconds) || ![86400,604800,2592000].includes(messageAutoDeleteSeconds))) return reply.code(400).send({ error: 'Invalid message auto-delete period' });
    db.prepare('UPDATE users SET self_destruct_days=?,message_auto_delete_seconds=?,updated_at=? WHERE id=?').run(selfDestructDays, messageAutoDeleteSeconds, Date.now(), request.user.sub);
    audit(`user:${request.user.sub}`, 'security.settings.update', `user:${request.user.sub}`, { selfDestructDays, messageAutoDeleteSeconds }, request);
    return { settings: { selfDestructDays, messageAutoDeleteSeconds } };
  });

  app.post('/api/account/delete', { preHandler: authenticate }, async (request, reply) => {
    const body = request.body as { confirmation?: string };
    if (body.confirmation !== '我确认注销账号') return reply.code(400).send({ error: 'Exact account deletion confirmation is required' });
    const id = request.user.sub;
    audit(`user:${id}`, 'account.delete', `user:${id}`, {}, request);
    db.prepare('DELETE FROM users WHERE id=?').run(id);
    return reply.code(204).send();
  });

  app.post('/api/disclaimer/accept', { preHandler: authenticate }, async (request, reply) => {
    const { version } = request.body as { version?: string };
    if (version !== DISCLAIMER_VERSION) return reply.code(409).send({ error: 'Only the current disclaimer version may be accepted', version: DISCLAIMER_VERSION });
    db.prepare('INSERT OR IGNORE INTO disclaimer_acceptances(user_id,version,accepted_at) VALUES (?,?,?)').run(request.user.sub, version, Date.now());
    audit(`user:${request.user.sub}`, 'disclaimer.accept', `user:${request.user.sub}`, { version }, request);
    return { accepted: true, version };
  });

  app.get('/api/announcements', { preHandler: authenticate }, async (request) => {
    const rows = db.prepare(`SELECT a.id,a.title,a.body,a.published_at publishedAt,a.created_by createdBy,a.confirm_required confirmRequired,ar.read_at readAt
      FROM announcements a LEFT JOIN announcement_reads ar ON ar.announcement_id=a.id AND ar.user_id=? WHERE a.archived_at IS NULL ORDER BY a.published_at DESC`).all(request.user.sub) as Array<Record<string, unknown>>;
    const announcements = rows.map(item => ({ ...item, id: String(item.id), publishedAt: new Date(item.publishedAt as number).toISOString(), confirmRequired: item.confirmRequired === 1, readAt: item.readAt ? new Date(item.readAt as number).toISOString() : null, authorName: item.createdBy === 'root' ? '蓝喵喵' : String(item.createdBy), authorRole: 'platform-admin' }));
    return { announcements, unreadCount: announcements.filter(item => !item.readAt).length };
  });

  app.post('/api/announcements/:id/read', { preHandler: authenticate }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM announcements WHERE id=? AND archived_at IS NULL').get(id)) return reply.code(404).send({ error: '公告不存在' });
    db.prepare('INSERT OR IGNORE INTO announcement_reads(announcement_id,user_id,read_at) VALUES (?,?,?)').run(id, request.user.sub, Date.now());
    return { read: true };
  });

  app.post('/api/announcements/read-all', { preHandler: authenticate }, async (request) => {
    const result = db.prepare(`INSERT OR IGNORE INTO announcement_reads(announcement_id,user_id,read_at)
      SELECT a.id,?,? FROM announcements a WHERE a.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM announcement_reads ar WHERE ar.announcement_id=a.id AND ar.user_id=?)`).run(request.user.sub, Date.now(), request.user.sub);
    return { updated: Number(result.changes) };
  });

  app.post('/api/platform-admin/redeem', { preHandler: authenticate }, async (request) => {
    const { code } = request.body as { code?: string };
    if (!code) throw new DomainError(400, 'Platform administrator code required');
    redeemPlatformAdminCode(db, request.user.sub, code);
    audit(`user:${request.user.sub}`, 'platform-admin.redeem', `user:${request.user.sub}`, {}, request);
    return appUser(request.user.sub);
  });

  app.patch('/api/profile', { preHandler: authenticate }, async (request, reply) => {
    const { displayName, name, avatarUrl, avatar, bio, gender } = request.body as { displayName?: string; name?: string; avatarUrl?: string | null; avatar?: string | null; bio?: string; gender?: string };
    const chosenName = displayName ?? name; const chosenAvatar = avatarUrl ?? avatar;
    if (!chosenName?.trim() || chosenName.trim().length > 40 || (bio?.length ?? 0) > 500 || !validAvatar(chosenAvatar) || (gender !== undefined && !['female','male','nonbinary','private'].includes(gender))) return reply.code(400).send({ error: '个人资料格式不正确' });
    db.prepare('UPDATE users SET display_name=?,avatar_url=?,bio=?,gender=COALESCE(?,gender),updated_at=? WHERE id=?').run(chosenName.trim(), chosenAvatar ?? null, bio ?? '', gender ?? null, Date.now(), request.user.sub);
    return appUser(request.user.sub);
  });
  app.put('/api/profile/identity', { preHandler: authenticate }, async (request, reply) => {
    const { currentFingerprint, identity } = request.body as { currentFingerprint?: string; identity?: unknown };
    if (!currentFingerprint || !publicIdentity(identity)) return reply.code(400).send({ error: 'Current fingerprint and valid public identity required' });
    const result = db.prepare('UPDATE users SET public_identity=?,identity_fingerprint=?,updated_at=? WHERE id=? AND identity_fingerprint=?').run(JSON.stringify(identity), identity.fingerprint, Date.now(), request.user.sub, currentFingerprint);
    if (!result.changes) return reply.code(409).send({ error: 'Current identity fingerprint does not match' });
    audit(`user:${request.user.sub}`, 'identity.rotate', `user:${request.user.sub}`, { previousFingerprint: currentFingerprint, nextFingerprint: identity.fingerprint }, request);
    return { updated: true };
  });

  // ─── 好友与会话：搜索、添加、接受、置顶、拉黑 ─────────────
  app.get('/api/contacts', { preHandler: authenticate }, async (request) => ({ contacts: (db.prepare(`SELECT c.status,c.requested_by requestedBy,c.request_message requestMessage,c.remark,u.id,u.uuid,u.email,u.display_name displayName,u.avatar_url avatarUrl,u.public_identity publicIdentity,u.platform_admin_at platformAdminAt,u.platform_admin_revoked_at platformAdminRevokedAt,qb.qq_number qqNumber,COALESCE(cp.pinned,0) pinned,COALESCE(cp.blocked,0) blocked
    FROM contacts c JOIN users u ON u.id=CASE WHEN c.user_id=? THEN c.contact_id ELSE c.user_id END LEFT JOIN qq_bindings qb ON qb.user_id=u.id LEFT JOIN contact_preferences cp ON cp.owner_id=? AND cp.contact_id=u.id WHERE c.user_id=? OR c.contact_id=? ORDER BY c.updated_at DESC`)
    .all(request.user.sub, request.user.sub, request.user.sub, request.user.sub) as Array<Record<string, unknown>>).map(row => ({ id: String(row.id), uuid: row.uuid, email: row.email, qqNumber: row.qqNumber ?? undefined, name: row.displayName, handle: String(row.id), avatar: row.avatarUrl ?? undefined, status: row.status, requestedBy: String(row.requestedBy), requestMessage: row.requestMessage ?? '', remark: row.remark ?? '', pinned: row.pinned === 1, blocked: row.blocked === 1, publicKey: row.publicIdentity ? (JSON.parse(row.publicIdentity as string) as { publicKey: unknown }).publicKey : undefined, role: row.platformAdminAt !== null && row.platformAdminRevokedAt === null ? 'platform-admin' : 'user', vip: isVip(db, Number(row.id)) })) }));

  app.get('/api/users/search', { preHandler: authenticate }, async (request, reply) => {
    const query = (request.query as { q?: string }).q?.trim() ?? '';
    if (!query) return reply.code(400).send({ error: 'Search query required' });
    const normalized = query.toLowerCase();
    return { users: (db.prepare(`SELECT u.id,u.uuid,u.email,u.display_name displayName,u.avatar_url avatarUrl,u.public_identity publicIdentity,u.platform_admin_at platformAdminAt,u.platform_admin_revoked_at platformAdminRevokedAt,qb.qq_number qqNumber
    FROM users u LEFT JOIN qq_bindings qb ON qb.user_id=u.id WHERE u.banned_at IS NULL AND u.id<>? AND (u.uuid=? OR u.email=? OR qb.qq_number=?) ORDER BY u.id LIMIT 20`).all(request.user.sub, query, normalized, query) as Array<Record<string, unknown>>).map(row => ({ id: String(row.id), uuid: row.uuid, email: row.email, qqNumber: row.qqNumber ?? undefined, name: row.displayName, handle: String(row.id), avatar: row.avatarUrl ?? undefined, publicKey: row.publicIdentity ? (JSON.parse(row.publicIdentity as string) as { publicKey: unknown }).publicKey : undefined, role: row.platformAdminAt !== null && row.platformAdminRevokedAt === null ? 'platform-admin' : 'user' })) };
   });

  app.post('/api/statuses', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const body = request.body as { kind?: unknown; text?: unknown; imageId?: unknown };
    const kind = body.kind === 'image' ? 'image' : body.kind === 'text' ? 'text' : '';
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const imageId = typeof body.imageId === 'string' ? body.imageId.trim() : '';
    if (!kind || (kind === 'text' && (!text || text.length > 2000)) || (kind === 'image' && !imageId)) return reply.code(400).send({ error: 'Invalid status content' });
    if (kind === 'text' && imageId) return reply.code(400).send({ error: 'Text status cannot contain an image' });
    if (kind === 'image' && !db.prepare("SELECT 1 FROM media_attachments WHERE id=? AND owner_id=? AND mime_type LIKE 'image/%'").get(imageId, request.user.sub)) return reply.code(403).send({ error: 'Image attachment ownership required' });
    const id = randomUUID(); const now = Date.now();
    db.prepare('INSERT INTO status_updates(id,author_id,kind,text_content,image_url,created_at,expires_at) VALUES (?,?,?,?,?,?,?)').run(id, request.user.sub, kind, kind === 'text' ? text : null, kind === 'image' ? imageId : null, now, now + 86_400_000);
    return reply.code(201).send({ id });
  });

  app.get('/api/statuses/feed', { preHandler: authenticate }, async (request) => {
    const now = Date.now(); db.prepare('DELETE FROM status_updates WHERE expires_at<=?').run(now);
    const rows = db.prepare(`SELECT s.id,s.author_id authorId,u.display_name authorName,u.avatar_url authorAvatar,s.kind,s.text_content text,s.image_url imageId,s.created_at createdAt,
      EXISTS(SELECT 1 FROM status_views v WHERE v.status_id=s.id AND v.viewer_id=?) viewed,
      (SELECT COUNT(*) FROM status_views v2 WHERE v2.status_id=s.id) viewCount
      FROM status_updates s JOIN users u ON u.id=s.author_id WHERE s.expires_at>? AND (s.author_id=? OR EXISTS(SELECT 1 FROM contacts c WHERE c.status='accepted' AND ((c.user_id=? AND c.contact_id=s.author_id) OR (c.contact_id=? AND c.user_id=s.author_id)))) ORDER BY s.created_at DESC`).all(request.user.sub, now, request.user.sub, request.user.sub, request.user.sub) as Array<Record<string, unknown>>;
    return { statuses: rows.map(row => ({ id: row.id, authorId: String(row.authorId), authorName: row.authorName, authorAvatar: row.authorAvatar ?? undefined, kind: row.kind, text: row.text ?? undefined, imageId: row.imageId ?? undefined, createdAt: new Date(Number(row.createdAt)).toISOString(), expiresAt: new Date(Number(row.createdAt) + 86_400_000).toISOString(), viewed: row.viewed === 1, viewCount: Number(row.viewCount) })) };
  });
  app.post('/api/statuses/:id/view', { preHandler: authenticate }, async (request, reply) => {
    const id = String((request.params as { id: string }).id); const now = Date.now();
    if (!db.prepare('SELECT 1 FROM status_updates WHERE id=? AND expires_at>?').get(id, now)) return reply.code(404).send({ error: 'Status not found' });
    db.prepare('INSERT OR IGNORE INTO status_views(status_id,viewer_id,viewed_at) VALUES (?,?,?)').run(id, request.user.sub, now); return { viewed: true };
  });
  app.delete('/api/statuses/:id', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const result = db.prepare('DELETE FROM status_updates WHERE id=? AND author_id=?').run(String((request.params as { id: string }).id), request.user.sub);
    if (!result.changes) return reply.code(404).send({ error: 'Status not found' }); return { deleted: true };
  });

  app.post('/api/contacts', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const { userId, message } = request.body as { userId?: string | number; message?: string }; const target = Number(userId);
    if (!Number.isInteger(target) || target === request.user.sub) return reply.code(400).send({ error: 'Valid userId required' });
    if (!db.prepare('SELECT 1 FROM users WHERE id=? AND banned_at IS NULL').get(target)) return reply.code(404).send({ error: 'User not found' });
    if (db.prepare('SELECT 1 FROM contact_preferences WHERE ((owner_id=? AND contact_id=?) OR (owner_id=? AND contact_id=?)) AND blocked=1').get(request.user.sub, target, target, request.user.sub)) return reply.code(403).send({ error: '你已被对方拉黑，无法发送申请' });
    const low = Math.min(request.user.sub, target); const high = Math.max(request.user.sub, target); const now = Date.now();
    const requestMessage = typeof message === 'string' ? message.trim().slice(0, 120) : '';
    db.prepare(`INSERT INTO contacts(user_id,contact_id,status,requested_by,request_message,created_at,updated_at) VALUES (?,?,'pending',?,?,?,?)
      ON CONFLICT(user_id,contact_id) DO UPDATE SET status='pending',requested_by=excluded.requested_by,request_message=excluded.request_message,updated_at=excluded.updated_at WHERE contacts.status <> 'accepted'`).run(low, high, request.user.sub, requestMessage, now, now);
    audit(`user:${request.user.sub}`, 'contact.request', `user:${target}`, { message: requestMessage }, request);
    for (const peer of sockets.get(target) ?? []) if (peer.readyState === 1) peer.send(JSON.stringify({ type: 'contact-request', from: request.user.sub }));
    return reply.code(201).send({ requested: true, userId: String(target) });
  });

  app.post('/api/contacts/requests', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const { userId } = request.body as { userId?: number };
    if (!Number.isInteger(userId) || userId === request.user.sub) return reply.code(400).send({ error: 'Valid userId required' });
    if (!db.prepare('SELECT 1 FROM users WHERE id=? AND banned_at IS NULL').get(userId!)) return reply.code(404).send({ error: 'User not found' });
    if (db.prepare('SELECT 1 FROM contact_preferences WHERE ((owner_id=? AND contact_id=?) OR (owner_id=? AND contact_id=?)) AND blocked=1').get(request.user.sub, userId!, userId!, request.user.sub)) return reply.code(403).send({ error: '你已被对方拉黑，无法发送申请' });
    const low = Math.min(request.user.sub, userId!); const high = Math.max(request.user.sub, userId!);
    try {
      db.prepare('INSERT INTO contacts(user_id, contact_id, status, requested_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(low, high, 'pending', request.user.sub, Date.now(), Date.now());
      for (const peer of sockets.get(userId!) ?? []) if (peer.readyState === 1) peer.send(JSON.stringify({ type: 'contact-request', from: request.user.sub }));
      return reply.code(201).send({ requested: true });
    } catch (error) {
      if (String(error).includes('UNIQUE')) return reply.code(409).send({ error: 'Contact relationship already exists' });
      throw error;
    }
  });

  app.patch('/api/contacts/requests/:userId', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const other = Number((request.params as { userId: string }).userId); const { accept } = request.body as { accept?: boolean };
    const low = Math.min(request.user.sub, other); const high = Math.max(request.user.sub, other);
    const result = db.prepare(`UPDATE contacts SET status=?, updated_at=? WHERE user_id=? AND contact_id=? AND status='pending' AND requested_by<>?`)
      .run(accept ? 'accepted' : 'rejected', Date.now(), low, high, request.user.sub);
    if (!result.changes) return reply.code(404).send({ error: 'Pending request not found' });
    audit(`user:${request.user.sub}`, accept ? 'contact.accept' : 'contact.reject', `user:${other}`, {}, request);
    return { updated: true };
  });

  app.delete('/api/contacts/:userId', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const other = Number((request.params as { userId: string }).userId);
    if (!Number.isInteger(other) || other === request.user.sub) return reply.code(400).send({ error: 'Valid userId required' });
    const low = Math.min(request.user.sub, other); const high = Math.max(request.user.sub, other);
    const result = db.prepare('DELETE FROM contacts WHERE user_id=? AND contact_id=?').run(low, high);
    if (!result.changes) return reply.code(404).send({ error: '好友关系不存在' });
    audit(`user:${request.user.sub}`, 'contact.remove', `user:${other}`, {}, request);
    return reply.code(204).send();
  });

  app.patch('/api/contacts/:userId', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const other = Number((request.params as { userId: string }).userId);
    const { remark } = request.body as { remark?: unknown };
    if (!Number.isInteger(other) || other === request.user.sub) return reply.code(400).send({ error: 'Valid userId required' });
    const value = typeof remark === 'string' ? remark.trim().slice(0, 40) : '';
    const low = Math.min(request.user.sub, other); const high = Math.max(request.user.sub, other);
    const result = db.prepare('UPDATE contacts SET remark=?, updated_at=? WHERE user_id=? AND contact_id=?').run(value, Date.now(), low, high);
    if (!result.changes) return reply.code(404).send({ error: '好友关系不存在' });
    audit(`user:${request.user.sub}`, 'contact.remark', `user:${other}`, { remark: value }, request);
    return { updated: true };
  });

  app.get('/api/conversations', { preHandler: authenticate }, async (request) => {
    const groups = (db.prepare('SELECT group_id groupId FROM group_members WHERE user_id=?').all(request.user.sub) as Array<{ groupId: number }>).map(row => groupConversation(row.groupId, request.user.sub));
    const contacts = (db.prepare(`SELECT CASE WHEN user_id=? THEN contact_id ELSE user_id END otherId FROM contacts WHERE status='accepted' AND (user_id=? OR contact_id=?)`).all(request.user.sub, request.user.sub, request.user.sub) as Array<{ otherId: number }>).map(row => directConversation(row.otherId, request.user.sub));
    return { conversations: [...groups, ...contacts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  });

  app.patch('/api/contacts/:userId/preferences', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const other = Number((request.params as { userId: string }).userId);
    const body = request.body as { pinned?: unknown; blocked?: unknown };
    if (!Number.isInteger(other) || other === request.user.sub) return reply.code(400).send({ error: 'Valid userId required' });
    const low = Math.min(request.user.sub, other); const high = Math.max(request.user.sub, other);
    if (!db.prepare("SELECT 1 FROM contacts WHERE user_id=? AND contact_id=? AND status='accepted'").get(low, high)) return reply.code(404).send({ error: 'Contact not found' });
    const old = db.prepare('SELECT pinned,blocked FROM contact_preferences WHERE owner_id=? AND contact_id=?').get(request.user.sub, other) as { pinned: number; blocked: number } | undefined;
    const pinned = typeof body.pinned === 'boolean' ? Number(body.pinned) : old?.pinned ?? 0;
    const blocked = typeof body.blocked === 'boolean' ? Number(body.blocked) : old?.blocked ?? 0;
    db.prepare(`INSERT INTO contact_preferences(owner_id,contact_id,pinned,blocked,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(owner_id,contact_id) DO UPDATE SET pinned=excluded.pinned,blocked=excluded.blocked,updated_at=excluded.updated_at`).run(request.user.sub, other, pinned, blocked, Date.now());
    return { pinned: Boolean(pinned), blocked: Boolean(blocked) };
  });

  app.post('/api/conversations/direct', { preHandler: [authenticate, requireDisclaimer] }, async (request) => {
    const { contactId } = request.body as { contactId?: string | number };
    return directConversation(Number(contactId), request.user.sub);
  });
  function conversationTarget(raw: string): { groupId?: number; targetId?: number } {
    if (raw.startsWith('g-')) { const groupId = resolveGroupId(raw); if (groupId === undefined) throw new DomainError(404, 'Group not found'); return { groupId }; }
    if (raw.startsWith('d-')) { const targetId = Number(raw.slice(2)); if (!Number.isInteger(targetId)) throw new DomainError(400, 'Invalid conversation id'); return { targetId }; }
    throw new DomainError(400, 'Invalid conversation id');
  }
  function assertConversationAccess(viewerId: number, target: { groupId?: number; targetId?: number }) {
    if (target.groupId !== undefined && !db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(target.groupId, viewerId)) throw new DomainError(403, 'Group membership required');
    if (target.targetId !== undefined) { const low = Math.min(viewerId, target.targetId); const high = Math.max(viewerId, target.targetId); if (!db.prepare("SELECT 1 FROM contacts WHERE user_id=? AND contact_id=? AND status='accepted'").get(low, high)) throw new DomainError(403, 'Accepted contact required'); }
  }
  app.patch('/api/conversations/:id/mute', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const target = conversationTarget(String((request.params as { id: string }).id)); assertConversationAccess(request.user.sub, target);
    const mutedUntil = (request.body as { mutedUntil?: unknown }).mutedUntil;
    if (mutedUntil !== null && (!Number.isFinite(mutedUntil) || Number(mutedUntil) <= Date.now())) return reply.code(400).send({ error: 'Invalid mute expiry' });
    const whereColumn = target.groupId !== undefined ? 'group_id=?' : 'target_id=?'; const whereValue = target.groupId ?? target.targetId;
    db.prepare(`DELETE FROM conversation_mutes WHERE owner_id=? AND ${whereColumn}`).run(request.user.sub, whereValue!);
    if (mutedUntil !== null) db.prepare('INSERT INTO conversation_mutes(owner_id,target_id,group_id,muted_until,updated_at) VALUES (?,?,?,?,?)').run(request.user.sub, target.targetId ?? null, target.groupId ?? null, Number(mutedUntil), Date.now());
    return { muted: mutedUntil !== null, mutedUntil: mutedUntil === null ? null : Number(mutedUntil) };
  });
  app.patch('/api/conversations/:id/disappearing', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const target = conversationTarget(String((request.params as { id: string }).id)); assertConversationAccess(request.user.sub, target);
    const seconds = Number((request.body as { seconds?: unknown }).seconds);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 2_592_000) return reply.code(400).send({ error: 'Invalid disappearing duration' });
    const whereColumn = target.groupId !== undefined ? 'group_id=?' : 'target_id=?'; const whereValue = target.groupId ?? target.targetId;
    db.prepare(`DELETE FROM conversation_disappearing WHERE owner_id=? AND ${whereColumn}`).run(request.user.sub, whereValue!);
    if (seconds > 0) db.prepare('INSERT INTO conversation_disappearing(owner_id,target_id,group_id,seconds,updated_at) VALUES (?,?,?,?,?)').run(request.user.sub, target.targetId ?? null, target.groupId ?? null, seconds, Date.now());
    return { seconds };
  });
  app.get('/api/conversations/:id/media', { preHandler: authenticate }, async (request) => {
    const target = conversationTarget(String((request.params as { id: string }).id)); assertConversationAccess(request.user.sub, target);
    const rows = target.groupId !== undefined
      ? db.prepare('SELECT id,original_name originalName,mime_type mimeType,size_bytes sizeBytes,created_at createdAt FROM media_attachments WHERE group_id=? ORDER BY created_at DESC').all(target.groupId)
      : db.prepare('SELECT id,original_name originalName,mime_type mimeType,size_bytes sizeBytes,created_at createdAt FROM media_attachments WHERE direct_recipient_id=? AND owner_id IN (?,?) ORDER BY created_at DESC').all(target.targetId!, request.user.sub, target.targetId!);
    return { media: rows };
  });
  app.get('/api/users/:userId/common-groups', { preHandler: authenticate }, async (request, reply) => {
    const userId = Number((request.params as { userId: string }).userId); const low = Math.min(request.user.sub, userId); const high = Math.max(request.user.sub, userId);
    if (!Number.isInteger(userId) || !db.prepare("SELECT 1 FROM contacts WHERE user_id=? AND contact_id=? AND status='accepted'").get(low, high)) return reply.code(403).send({ error: 'Accepted contact required' });
    return { groups: db.prepare(`SELECT g.id,g.name,g.avatar_url avatar,g.public_number groupNumber,COUNT(gm2.user_id) memberCount FROM chat_groups g JOIN group_members mine ON mine.group_id=g.id AND mine.user_id=? JOIN group_members other ON other.group_id=g.id AND other.user_id=? JOIN group_members gm2 ON gm2.group_id=g.id GROUP BY g.id ORDER BY g.name`).all(request.user.sub, userId).map((row: any) => ({ ...row, id: `g-${row.id}`, groupNumber: String(row.groupNumber ?? row.id) })) };
  });

  // ─── 群组：创建、入群、设置、角色、禁言、解散 ─────────────
  app.post('/api/groups', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const { name, joinMode, joinQuestion, memberIds } = request.body as { name?: string; joinMode?: string; joinQuestion?: string; memberIds?: Array<string | number> };
    if (!name?.trim() || name.trim().length > 60) return reply.code(400).send({ error: 'Group name required' });
    if (joinMode && !['open', 'approval', 'question', 'closed'].includes(joinMode)) return reply.code(400).send({ error: 'Invalid join mode' });
    if (joinMode === 'question' && !joinQuestion?.trim()) return reply.code(400).send({ error: 'Join question required' });
    for (const rawMemberId of memberIds ?? []) {
      const memberId = Number(rawMemberId); const low = Math.min(request.user.sub, memberId); const high = Math.max(request.user.sub, memberId);
      if (!Number.isInteger(memberId) || !db.prepare("SELECT 1 FROM contacts WHERE user_id=? AND contact_id=? AND status='accepted'").get(low, high)) return reply.code(403).send({ error: '群聊只能直接邀请已添加的好友' });
    }
    const id = createGroup(db, request.user.sub, name.trim(), Date.now(), isPlatformAdmin(db, request.user.sub));
    db.prepare('UPDATE chat_groups SET public_number=?,join_mode=?,join_question=? WHERE id=?').run(newGroupNumber(), joinMode ?? 'approval', joinMode === 'question' ? joinQuestion!.trim().slice(0, 300) : null, id);
    for (const memberId of memberIds ?? []) addGroupMember(db, id, request.user.sub, Number(memberId), Date.now(), isPlatformAdmin(db, request.user.sub));
    audit(`user:${request.user.sub}`, 'group.create', `group:${id}`, { joinMode: joinMode ?? 'approval' }, request);
    return reply.code(201).send(groupConversation(id, request.user.sub));
  });
  app.get('/api/groups', { preHandler: authenticate }, async (request) => ({ groups: db.prepare(`SELECT g.id,g.name,g.owner_id ownerId,g.join_mode joinMode,g.join_question joinQuestion,mine.role,mine.forced_by forcedBy,COUNT(gm.user_id) memberCount FROM chat_groups g JOIN group_members mine ON mine.group_id=g.id AND mine.user_id=? LEFT JOIN group_members gm ON gm.group_id=g.id GROUP BY g.id ORDER BY g.created_at DESC`).all(request.user.sub) }));
  app.get('/api/groups/:groupId/members', { preHandler: authenticate }, async (request, reply) => {
    const groupId = Number((request.params as { groupId: string }).groupId);
    if (!db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(groupId, request.user.sub)) return reply.code(403).send({ error: 'Group membership required' });
    return { members: db.prepare(`SELECT u.id,u.uuid,u.display_name displayName,gm.role,gm.joined_at joinedAt,gm.forced_by forcedBy,
      CASE WHEN gm.forced_by IS NULL THEN 0 ELSE 1 END forcedMembership FROM group_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=? ORDER BY gm.joined_at`).all(groupId) };
  });
  app.get('/api/groups/:groupId/join-info', { preHandler: authenticate }, async (request, reply) => {
    const raw = (request.params as { groupId: string }).groupId;
    const groupId = resolveGroupId(raw);
    const group = groupId === undefined ? undefined : db.prepare('SELECT id,public_number publicNumber,name,join_mode joinMode,join_question joinQuestion,auto_review autoReview FROM chat_groups WHERE id=?').get(groupId) as Record<string, unknown> | undefined;
    return group ? { groupId: String(group.id), groupNumber: String(group.publicNumber ?? group.id), groupName: group.name, joinMode: group.joinMode, joinQuestion: group.joinQuestion ?? undefined, autoReview: group.autoReview === 1 } : reply.code(404).send({ error: 'Group not found' });
  });
  app.post('/api/groups/:groupId/members', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const groupId = Number((request.params as { groupId: string }).groupId); const { userId } = request.body as { userId?: number };
    if (!Number.isInteger(groupId) || !Number.isInteger(userId)) return reply.code(400).send({ error: 'Valid ids required' });
    if (!canGovernGroup(groupId, request.user.sub)) return reply.code(403).send({ error: '只有群主或管理员可以邀请好友' });
    const low = Math.min(request.user.sub, userId!); const high = Math.max(request.user.sub, userId!);
    if (!db.prepare("SELECT 1 FROM contacts WHERE user_id=? AND contact_id=? AND status='accepted'").get(low, high)) return reply.code(403).send({ error: '只能直接邀请已添加的好友，陌生人需要按群号申请加入' });
    const group = db.prepare('SELECT owner_id ownerId FROM chat_groups WHERE id=?').get(groupId) as { ownerId: number } | undefined;
    if (!group) return reply.code(404).send({ error: 'Group not found' });
    addGroupMember(db, groupId, group.ownerId, userId!, Date.now(), isPlatformAdmin(db, group.ownerId));
    audit(`user:${request.user.sub}`, 'group.member-add', `user:${userId}`, { groupId }, request);
    return reply.code(201).send({ added: true });
  });
  app.patch('/api/groups/:groupId/settings', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const groupId = Number((request.params as { groupId: string }).groupId); const { joinMode, joinQuestion, autoReview, joinAnswer, avatar, name, description } = request.body as { joinMode?: string; joinQuestion?: string | null; autoReview?: boolean; joinAnswer?: string | null; avatar?: unknown; name?: unknown; description?: unknown };
    if (!['open', 'approval', 'question', 'closed'].includes(joinMode ?? '') || (joinMode === 'question' && !joinQuestion?.trim()) || (joinMode === 'question' && autoReview === true && !joinAnswer?.trim())) return reply.code(400).send({ error: '请填写有效的入群模式、问题和标准答案' });
    if (typeof name !== 'undefined' && (typeof name !== 'string' || !name.trim() || name.trim().length > 60)) return reply.code(400).send({ error: '群名称格式不正确' });
    if (typeof description !== 'undefined' && (typeof description !== 'string' || description.length > 500)) return reply.code(400).send({ error: '群简介格式不正确' });
    if (!validAvatar(avatar)) return reply.code(400).send({ error: '群头像格式不正确' });
    if (!canGovernGroup(groupId, request.user.sub)) return reply.code(403).send({ error: 'Group governance membership required' });
    const current = db.prepare('SELECT avatar_url avatarUrl,name,description FROM chat_groups WHERE id=?').get(groupId) as { avatarUrl: string | null; name: string; description: string | null } | undefined;
    if (!current) return reply.code(404).send({ error: 'Group not found' });
    db.prepare('UPDATE chat_groups SET name=?,description=?,join_mode=?,join_question=?,auto_review=?,join_answer=?,avatar_url=? WHERE id=?').run(typeof name === 'string' ? name.trim() : current.name, typeof description === 'string' ? description.trim().slice(0, 500) : typeof description === 'undefined' ? current.description : null, joinMode!, joinMode === 'question' ? joinQuestion!.trim().slice(0, 300) : null, joinMode === 'question' && autoReview === true ? 1 : 0, joinMode === 'question' && autoReview === true ? joinAnswer!.trim().slice(0, 300) : null, avatar === undefined ? current.avatarUrl : avatar, groupId);
    audit(`user:${request.user.sub}`, 'group.settings', `group:${groupId}`, { joinMode, autoReview: autoReview === true, avatarChanged: avatar !== undefined }, request); return groupConversation(groupId, request.user.sub);
  });
  app.patch('/api/groups/:groupId/profile', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const groupId = Number((request.params as { groupId: string }).groupId); const avatar = (request.body as { avatar?: unknown }).avatar;
    if (!validAvatar(avatar)) return reply.code(400).send({ error: '群头像格式不正确' });
    if (!canGovernGroup(groupId, request.user.sub)) return reply.code(403).send({ error: 'Group governance membership required' });
    const result = db.prepare('UPDATE chat_groups SET avatar_url=? WHERE id=?').run(avatar ?? null, groupId);
    if (!result.changes) return reply.code(404).send({ error: 'Group not found' }); return groupConversation(groupId, request.user.sub);
  });
  app.post('/api/groups/:groupId/join', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const groupId = resolveGroupId((request.params as { groupId: string }).groupId); const { answer } = request.body as { answer?: string };
    if (groupId === undefined) return reply.code(404).send({ error: 'Group not found' });
    const group = db.prepare('SELECT owner_id,join_mode,join_question,auto_review,join_answer FROM chat_groups WHERE id=?').get(groupId) as { owner_id: number; join_mode: string; join_question: string | null; auto_review: number; join_answer: string | null } | undefined;
    if (!group) return reply.code(404).send({ error: 'Group not found' });
    if (group.join_mode === 'closed') return reply.code(403).send({ error: 'Group is closed' });
    if (group.join_mode === 'question' && !answer?.trim()) return reply.code(400).send({ error: 'Answer required' });
    if (group.join_mode === 'open') {
      addGroupMember(db, groupId, group.owner_id, request.user.sub, Date.now(), isPlatformAdmin(db, group.owner_id));
      audit(`user:${request.user.sub}`, 'group.join', `group:${groupId}`, { mode: 'open' }, request); return reply.code(201).send({ state: 'joined' });
    }
    if (group.join_mode === 'question' && group.auto_review === 1) {
      const normalize = (value: string) => value.trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ');
      if (!group.join_answer || normalize(answer ?? '') !== normalize(group.join_answer)) {
        audit(`user:${request.user.sub}`, 'group.join-auto-reject', `group:${groupId}`, {}, request);
        return reply.code(400).send({ error: '入群答案不正确' });
      }
      addGroupMember(db, groupId, group.owner_id, request.user.sub, Date.now(), isPlatformAdmin(db, group.owner_id));
      audit(`user:${request.user.sub}`, 'group.join-auto-approve', `group:${groupId}`, {}, request);
      return reply.code(201).send({ state: 'joined' });
    }
    const result = db.prepare('INSERT INTO group_join_requests(group_id,user_id,answer,created_at) VALUES (?,?,?,?)').run(groupId, request.user.sub, answer?.trim().slice(0, 500) ?? null, Date.now());
    audit(`user:${request.user.sub}`, 'group.join-request', `group:${groupId}`, {}, request); return reply.code(202).send({ state: 'pending', requestId: String(result.lastInsertRowid) });
  });
  app.get('/api/groups/:groupId/join-requests', { preHandler: authenticate }, async (request, reply) => {
    const groupId = Number((request.params as { groupId: string }).groupId);
    if (!canGovernGroup(groupId, request.user.sub)) return reply.code(403).send({ error: 'Group governance membership required' });
    const group = db.prepare('SELECT public_number publicNumber FROM chat_groups WHERE id=?').get(groupId) as { publicNumber: string | null };
    return { requests: (db.prepare(`SELECT r.id,r.user_id userId,u.uuid,u.display_name displayName,u.avatar_url avatarUrl,u.public_identity publicIdentity,r.answer,r.created_at createdAt FROM group_join_requests r JOIN users u ON u.id=r.user_id WHERE r.group_id=? AND r.status='pending' ORDER BY r.created_at`).all(groupId) as Array<Record<string, unknown>>).map(row => ({ id: String(row.id), groupId: String(groupId), groupNumber: group.publicNumber ?? String(groupId), user: { id: String(row.userId), uuid: row.uuid, name: row.displayName, handle: String(row.userId), avatar: row.avatarUrl ?? undefined, status: 'offline', publicKey: row.publicIdentity ? (JSON.parse(row.publicIdentity as string) as { publicKey: unknown }).publicKey : undefined }, answer: row.answer ?? undefined, status: 'pending', createdAt: new Date(row.createdAt as number).toISOString() })) };
  });
  app.get('/api/group-join-requests', { preHandler: authenticate }, async (request) => {
    const platformAdmin = isPlatformAdmin(db, request.user.sub) ? 1 : 0;
    const rows = db.prepare(`SELECT r.id,r.group_id groupId,g.public_number groupNumber,g.name groupName,r.user_id userId,u.uuid,u.email,u.display_name displayName,u.avatar_url avatarUrl,u.public_identity publicIdentity,qb.qq_number qqNumber,r.answer,r.created_at createdAt
      FROM group_join_requests r JOIN chat_groups g ON g.id=r.group_id JOIN group_members mine ON mine.group_id=g.id AND mine.user_id=?
      JOIN users u ON u.id=r.user_id LEFT JOIN qq_bindings qb ON qb.user_id=u.id
      WHERE r.status='pending' AND (mine.role IN ('owner','moderator') OR ?=1) ORDER BY r.created_at`) .all(request.user.sub, platformAdmin) as Array<Record<string, unknown>>;
    return { requests: rows.map(row => ({ id: String(row.id), groupId: String(row.groupId), groupNumber: String(row.groupNumber ?? row.groupId), groupName: row.groupName, status: 'pending',
      user: { id: String(row.userId), uuid: row.uuid, email: row.email, qqNumber: row.qqNumber ?? undefined, name: row.displayName, handle: String(row.userId), avatar: row.avatarUrl ?? undefined, status: 'offline', publicKey: row.publicIdentity ? (JSON.parse(row.publicIdentity as string) as { publicKey: unknown }).publicKey : undefined },
      answer: row.answer ?? undefined, createdAt: new Date(row.createdAt as number).toISOString() })) };
  });
  app.get('/api/my-group-join-requests', { preHandler: authenticate }, async (request) => {
    const rows = db.prepare(`SELECT r.id,r.group_id groupId,g.public_number groupNumber,g.name groupName,r.answer,r.status,r.rejection_reason rejectionReason,r.created_at createdAt,r.reviewed_at reviewedAt
      FROM group_join_requests r JOIN chat_groups g ON g.id=r.group_id WHERE r.user_id=? ORDER BY r.created_at DESC LIMIT 100`).all(request.user.sub) as Array<Record<string, unknown>>;
    return { requests: rows.map(row => ({ id: String(row.id), groupId: String(row.groupId), groupNumber: String(row.groupNumber ?? row.groupId), groupName: row.groupName, answer: row.answer ?? undefined, status: row.status, rejectionReason: row.rejectionReason ?? undefined, createdAt: new Date(row.createdAt as number).toISOString(), reviewedAt: row.reviewedAt ? new Date(row.reviewedAt as number).toISOString() : undefined })) };
  });
  app.post('/api/groups/:groupId/join-requests/:requestId', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const { groupId: rawGroupId, requestId: rawRequestId } = request.params as { groupId: string; requestId: string }; const groupId = Number(rawGroupId); const requestId = Number(rawRequestId); const { approve, reason } = request.body as { approve?: boolean; reason?: unknown };
    const rejectionReason = typeof reason === 'string' ? reason.trim().slice(0, 300) : '';
    if (approve === false && !rejectionReason) return reply.code(400).send({ error: '拒绝入群申请时必须填写理由' });
    if (!canGovernGroup(groupId, request.user.sub)) return reply.code(403).send({ error: 'Group governance membership required' });
    db.exec('BEGIN IMMEDIATE');
    try {
      const pending = db.prepare("SELECT user_id FROM group_join_requests WHERE id=? AND group_id=? AND status='pending'").get(requestId, groupId) as { user_id: number } | undefined;
      if (!pending) throw new DomainError(404, 'Pending request not found');
      if (approve) {
        const owner = db.prepare('SELECT owner_id FROM chat_groups WHERE id=?').get(groupId) as { owner_id: number };
        const limit = isVip(db, owner.owner_id) ? 300 : 100;
        const count = (db.prepare('SELECT COUNT(*) count FROM group_members WHERE group_id=?').get(groupId) as { count: number }).count;
        if (!isPlatformAdmin(db, owner.owner_id) && count >= limit) throw new DomainError(409, `Group member limit is ${limit}`);
        db.prepare("INSERT OR IGNORE INTO group_members(group_id,user_id,joined_at,role) VALUES (?,?,?,'member')").run(groupId, pending.user_id, Date.now());
      }
      db.prepare('UPDATE group_join_requests SET status=?,rejection_reason=?,reviewed_by=?,reviewed_at=? WHERE id=?').run(approve ? 'approved' : 'rejected', approve ? null : rejectionReason, request.user.sub, Date.now(), requestId);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    audit(`user:${request.user.sub}`, approve ? 'group.join-approve' : 'group.join-reject', `group:${groupId}`, { requestId, reason: approve ? undefined : rejectionReason }, request); return { updated: true };
  });
  app.post('/api/groups/:groupId/leave', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const groupId = Number((request.params as { groupId: string }).groupId);
    const membership = db.prepare('SELECT role FROM group_members WHERE group_id=? AND user_id=?').get(groupId, request.user.sub) as { role: string } | undefined;
    if (!membership) return reply.code(404).send({ error: '您不在该群组中' });
    if (membership.role === 'owner') return reply.code(403).send({ error: '群主不能退出，请解散群组' });
    db.prepare('DELETE FROM group_members WHERE group_id=? AND user_id=?').run(groupId, request.user.sub);
    audit(`user:${request.user.sub}`, 'group.leave', `group:${groupId}`, {}, request);
    return { left: true };
  });

  app.patch('/api/groups/:groupId/members/:userId/role', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const { groupId: rawGroupId, userId: rawUserId } = request.params as { groupId: string; userId: string }; const groupId = Number(rawGroupId); const userId = Number(rawUserId); const { role } = request.body as { role?: string };
    if (!['member', 'moderator'].includes(role ?? '')) return reply.code(400).send({ error: 'Role must be member or moderator' });
    const actorIsPlatformAdmin = isPlatformAdmin(db, request.user.sub) && Boolean(db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(groupId, request.user.sub));
    if (!actorIsPlatformAdmin && !db.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=? AND role='owner'").get(groupId, request.user.sub)) return reply.code(403).send({ error: 'Group owner or joined platform administrator required' });
    if (isPlatformAdmin(db, userId)) return reply.code(403).send({ error: 'Cannot change an active platform administrator' });
    const result = db.prepare("UPDATE group_members SET role=? WHERE group_id=? AND user_id=? AND role<>'owner'").run(role!, groupId, userId);
    if (!result.changes) return reply.code(404).send({ error: 'Eligible member not found' });
    audit(`user:${request.user.sub}`, 'group.role', `user:${userId}`, { groupId, role }, request); return { updated: true };
  });
  app.patch('/api/groups/:groupId/members/:userId/profile', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const { groupId: rawGroupId, userId: rawUserId } = request.params as { groupId: string; userId: string };
    const groupId = Number(rawGroupId); const userId = Number(rawUserId);
    const { title, level } = request.body as { title?: unknown; level?: unknown };
    if (!canGovernGroup(groupId, request.user.sub)) return reply.code(403).send({ error: '只有群主或管理员可以设置成员头衔' });
    const memberTitle = typeof title === 'string' ? title.trim().slice(0, 20) : '';
    const memberLevel = Number(level);
    if (!Number.isInteger(memberLevel) || memberLevel < 1 || memberLevel > 100) return reply.code(400).send({ error: '成员等级必须为 1-100' });
    const result = db.prepare('UPDATE group_members SET member_title=?,member_level=? WHERE group_id=? AND user_id=?').run(memberTitle, memberLevel, groupId, userId);
    if (!result.changes) return reply.code(404).send({ error: '群成员不存在' });
    audit(`user:${request.user.sub}`, 'group.member-profile', `user:${userId}`, { groupId, title: memberTitle, level: memberLevel }, request);
    return { updated: true };
  });
  app.post('/api/groups/:groupId/mutes', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const groupId = Number((request.params as { groupId: string }).groupId); const { userId, expiresAt, reason } = request.body as { userId?: number; expiresAt?: number; reason?: string };
    if (!Number.isInteger(userId) || !Number.isFinite(expiresAt) || expiresAt! <= Date.now()) return reply.code(400).send({ error: 'Valid userId and future expiresAt required' });
    if (!canGovernGroup(groupId, request.user.sub)) return reply.code(403).send({ error: 'Group governance membership required' });
    const target = db.prepare('SELECT role FROM group_members WHERE group_id=? AND user_id=?').get(groupId, userId!) as { role: string } | undefined;
    const actor = db.prepare('SELECT role FROM group_members WHERE group_id=? AND user_id=?').get(groupId, request.user.sub) as { role: string };
    if (!target || isPlatformAdmin(db, userId!) || (!isPlatformAdmin(db, request.user.sub) && (target.role === 'owner' || (actor.role === 'moderator' && target.role === 'moderator')))) return reply.code(403).send({ error: 'Cannot mute this group member' });
    db.prepare('UPDATE user_mutes SET revoked_at=? WHERE user_id=? AND group_id=? AND revoked_at IS NULL').run(Date.now(), userId!, groupId);
    db.prepare('INSERT INTO user_mutes(user_id,group_id,expires_at,reason,created_by,created_at) VALUES (?,?,?,?,?,?)').run(userId!, groupId, expiresAt!, reason?.slice(0, 300) ?? null, request.user.sub, Date.now());
    audit(`user:${request.user.sub}`, 'group.mute', `user:${userId}`, { groupId, expiresAt, reason }, request); return reply.code(201).send({ muted: true });
  });
  app.delete('/api/groups/:groupId/mutes/:userId', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const groupId = Number((request.params as { groupId: string }).groupId); const userId = Number((request.params as { userId: string }).userId);
    if (!canGovernGroup(groupId, request.user.sub)) return reply.code(403).send({ error: 'Group governance membership required' });
    const result = db.prepare('UPDATE user_mutes SET revoked_at=? WHERE group_id=? AND user_id=? AND revoked_at IS NULL').run(Date.now(), groupId, userId);
    return { revoked: Number(result.changes) > 0 };
  });
  app.post('/api/groups/:groupId/mutes/all', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const groupId = Number((request.params as { groupId: string }).groupId); const expiresAt = Number((request.body as { expiresAt?: unknown }).expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || !canGovernGroup(groupId, request.user.sub)) return reply.code(403).send({ error: 'Valid governance and expiry required' });
    const actor = db.prepare('SELECT role FROM group_members WHERE group_id=? AND user_id=?').get(groupId, request.user.sub) as { role: string };
    const members = db.prepare("SELECT user_id userId FROM group_members WHERE group_id=? AND role<>'owner'").all(groupId) as Array<{ userId: number }>;
    const insert = db.prepare('INSERT INTO user_mutes(user_id,group_id,expires_at,reason,created_by,created_at) VALUES (?,?,?,?,?,?)'); let count = 0;
    for (const member of members) { if (isPlatformAdmin(db, member.userId) || (!isPlatformAdmin(db, request.user.sub) && actor.role === 'moderator' && (db.prepare('SELECT role FROM group_members WHERE group_id=? AND user_id=?').get(groupId, member.userId) as { role: string }).role === 'moderator')) continue; insert.run(member.userId, groupId, expiresAt, 'Mute all', request.user.sub, Date.now()); count++; }
    return { count };
  });
  app.delete('/api/groups/:groupId/mutes/all', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const groupId = Number((request.params as { groupId: string }).groupId); if (!canGovernGroup(groupId, request.user.sub)) return reply.code(403).send({ error: 'Group governance membership required' });
    db.prepare('UPDATE user_mutes SET revoked_at=? WHERE group_id=? AND revoked_at IS NULL').run(Date.now(), groupId); return { revoked: true };
  });
  app.delete('/api/groups/:groupId/members/:userId', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const { groupId: rawGroupId, userId: rawUserId } = request.params as { groupId: string; userId: string }; const groupId = Number(rawGroupId); const userId = Number(rawUserId);
    if (!canGovernGroup(groupId, request.user.sub)) return reply.code(403).send({ error: 'Group governance membership required' });
    if (userId === request.user.sub || isPlatformAdmin(db, userId)) return reply.code(403).send({ error: 'Cannot remove this member' });
    const target = db.prepare('SELECT role FROM group_members WHERE group_id=? AND user_id=?').get(groupId, userId) as { role: string } | undefined;
    const actor = db.prepare('SELECT role FROM group_members WHERE group_id=? AND user_id=?').get(groupId, request.user.sub) as { role: string } | undefined;
    if (!target || !actor || (!isPlatformAdmin(db, request.user.sub) && (target.role === 'owner' || (actor.role === 'moderator' && target.role !== 'member')))) return reply.code(403).send({ error: 'Cannot remove this member' });
    db.prepare('DELETE FROM group_members WHERE group_id=? AND user_id=?').run(groupId, userId);
    audit(`user:${request.user.sub}`, 'group.member-remove', `user:${userId}`, { groupId }, request); return reply.code(204).send();
  });
  app.post('/api/platform-admin/groups/:groupId/force-join', { preHandler: [authenticate, requireDisclaimer, requirePlatformAdmin] }, async (request, reply) => {
    const groupId = Number((request.params as { groupId: string }).groupId); forceJoinGroup(db, groupId, request.user.sub);
    audit(`platform-admin:${request.user.sub}`, 'group.force-join', `group:${groupId}`, { visibleMembership: true }, request); return reply.code(201).send({ joined: true, visible: true });
  });
  app.post('/api/platform-admin/messages/:messageId/remove', { preHandler: [authenticate, requireDisclaimer, requirePlatformAdmin] }, async (request, reply) => {
    const messageId = (request.params as { messageId: string }).messageId; const { reason } = request.body as { reason?: string };
    const message = db.prepare('SELECT sender_id,recipient_id,group_id,removed_at FROM message_metadata WHERE id=?').get(messageId) as { sender_id: number; recipient_id: number | null; group_id: number | null; removed_at: number | null } | undefined;
    if (!message || message.group_id === null) return reply.code(404).send({ error: 'Group message metadata not found' });
    if (!db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(message.group_id, request.user.sub)) return reply.code(403).send({ error: 'Visible group membership required' });
    if (isPlatformAdmin(db, message.sender_id)) return reply.code(403).send({ error: 'Cannot remove another active platform administrator message' });
    if (message.removed_at !== null) return reply.code(409).send({ error: 'Message already removed' });
    const now = Date.now(); db.prepare('UPDATE message_metadata SET removed_at=?,removed_by=?,removal_reason=? WHERE id=?').run(now, request.user.sub, reason?.slice(0, 300) || 'Platform moderation', messageId);
    db.prepare('DELETE FROM message_queue WHERE id=?').run(messageId); db.prepare('DELETE FROM group_message_queue WHERE message_id=?').run(messageId);
    const tombstone = JSON.stringify({ type: 'moderation-tombstone', messageId, groupId: message.group_id, removedAt: now, removedBy: { role: 'platform_admin', label: '平台管理员' }, reason: reason?.slice(0, 300) || 'Platform moderation' });
    const recipients = message.group_id === null ? [message.sender_id, message.recipient_id!] : (db.prepare('SELECT user_id FROM group_members WHERE group_id=?').all(message.group_id) as Array<{ user_id: number }>).map(row => row.user_id);
    for (const id of recipients) for (const peer of sockets.get(id) ?? []) if (peer.readyState === 1) peer.send(tombstone);
    audit(`platform-admin:${request.user.sub}`, 'message.remove', `message:${messageId}`, { groupId: message.group_id, reason }, request); return { removed: true, tombstone: true, contentInspected: false };
  });
  app.post('/api/messages/:messageId/recall', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const messageId = (request.params as { messageId: string }).messageId;
    const message = db.prepare('SELECT sender_id senderId,recipient_id recipientId,group_id groupId,removed_at removedAt FROM message_metadata WHERE id=?').get(messageId) as { senderId: number; recipientId: number | null; groupId: number | null; removedAt: number | null } | undefined;
    if (!message) return reply.code(404).send({ error: '消息不存在或已过期' });
    if (message.senderId !== request.user.sub) return reply.code(403).send({ error: '只能撤回自己发送的消息' });
    if (message.removedAt !== null) return reply.code(409).send({ error: '消息已经撤回' });
    const now = Date.now();
    db.prepare('UPDATE message_metadata SET removed_at=?,removed_by=?,removal_reason=? WHERE id=?').run(now, request.user.sub, 'Sender recall', messageId);
    db.prepare('DELETE FROM message_queue WHERE id=?').run(messageId);
    db.prepare('DELETE FROM group_message_queue WHERE message_id=?').run(messageId);
    const notify = (userId: number, conversationId: string) => {
      const frame = JSON.stringify({ type: 'message-recalled', messageId, conversationId, recalledAt: now });
      for (const peer of sockets.get(userId) ?? []) if (peer.readyState === 1) peer.send(frame);
    };
    if (message.groupId !== null) {
      for (const member of db.prepare('SELECT user_id userId FROM group_members WHERE group_id=?').all(message.groupId) as Array<{ userId: number }>) notify(member.userId, `g-${message.groupId}`);
    } else if (message.recipientId !== null) {
      notify(message.senderId, `d-${message.recipientId}`);
      notify(message.recipientId, `d-${message.senderId}`);
    }
    audit(`user:${request.user.sub}`, 'message.recall', `message:${messageId}`, {}, request);
    return { recalled: true };
  });
  function messageRecipients(message: { senderId: number; recipientId: number | null; groupId: number | null }): number[] {
    return message.groupId !== null ? (db.prepare('SELECT user_id userId FROM group_members WHERE group_id=?').all(message.groupId) as Array<{ userId: number }>).map(row => row.userId) : [message.senderId, ...(message.recipientId === null ? [] : [message.recipientId])];
  }
  // ─── 消息：已读、回应、编辑、撤回、移除 ─────────────────
  app.post('/api/messages/:messageId/read', { preHandler: [authenticate, requireDisclaimer], config: { rateLimit: false } }, async (request, reply) => {
    const messageId = String((request.params as { messageId: string }).messageId);
    const message = db.prepare('SELECT sender_id senderId,recipient_id recipientId,group_id groupId FROM message_metadata WHERE id=?').get(messageId) as { senderId: number; recipientId: number | null; groupId: number | null } | undefined;
    if (!message) return { read: true };
    if (!messageRecipients(message).includes(request.user.sub)) return reply.code(403).send({ error: 'Conversation participant required' });
    db.prepare('INSERT INTO message_reads(message_id,user_id,read_at) VALUES (?,?,?) ON CONFLICT(message_id,user_id) DO UPDATE SET read_at=excluded.read_at').run(messageId, request.user.sub, Date.now());
    const conversationId = message.groupId === null ? `d-${message.senderId === request.user.sub ? message.recipientId : message.senderId}` : `g-${message.groupId}`;
    for (const recipient of messageRecipients(message).filter(id => id !== request.user.sub)) { const frame = JSON.stringify({ type: 'message-read', messageId, conversationId: message.groupId === null ? `d-${recipient === message.senderId ? message.recipientId : message.senderId}` : conversationId, readerId: String(request.user.sub) }); for (const peer of sockets.get(recipient) ?? []) if (peer.readyState === 1) peer.send(frame); }
    return { read: true };
  });
  app.post('/api/messages/:messageId/reactions', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const messageId = String((request.params as { messageId: string }).messageId); const emoji = (request.body as { emoji?: unknown }).emoji;
    if (typeof emoji !== 'string' || !emoji.trim() || [...emoji].length > 16) return reply.code(400).send({ error: 'Invalid emoji' });
    const message = db.prepare('SELECT sender_id senderId,recipient_id recipientId,group_id groupId FROM message_metadata WHERE id=?').get(messageId) as { senderId: number; recipientId: number | null; groupId: number | null } | undefined;
    if (!message) return reply.code(404).send({ error: 'Message not found' }); if (!messageRecipients(message).includes(request.user.sub)) return reply.code(403).send({ error: 'Conversation participant required' });
    db.prepare('INSERT INTO message_reactions(id,message_id,user_id,emoji,created_at) VALUES (?,?,?,?,?) ON CONFLICT(message_id,user_id) DO UPDATE SET emoji=excluded.emoji,created_at=excluded.created_at').run(randomUUID(), messageId, request.user.sub, emoji.trim(), Date.now());
    const reactions = (db.prepare('SELECT r.user_id userId,u.display_name displayName,r.emoji,r.created_at createdAt FROM message_reactions r JOIN users u ON u.id=r.user_id WHERE r.message_id=? ORDER BY r.created_at').all(messageId) as Array<Record<string, unknown>>).map(row => ({ ...row, userId: String(row.userId), createdAt: new Date(Number(row.createdAt)).toISOString() }));
    const conversationId = message.groupId === null ? `d-${message.senderId === request.user.sub ? message.recipientId : message.senderId}` : `g-${message.groupId}`;
    for (const recipient of messageRecipients(message)) { const frame = JSON.stringify({ type: 'message-reactions', messageId, conversationId: message.groupId === null ? `d-${recipient === message.senderId ? message.recipientId : message.senderId}` : conversationId, reactions }); for (const peer of sockets.get(recipient) ?? []) if (peer.readyState === 1) peer.send(frame); }
    return { reactions };
  });
  app.post('/api/messages/:messageId/edit', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const messageId = String((request.params as { messageId: string }).messageId); const envelopes = (request.body as { envelopes?: unknown }).envelopes;
    const message = db.prepare('SELECT sender_id senderId,recipient_id recipientId,group_id groupId,removed_at removedAt,edit_count editCount FROM message_metadata WHERE id=?').get(messageId) as { senderId: number; recipientId: number | null; groupId: number | null; removedAt: number | null; editCount: number } | undefined;
    if (!message) return reply.code(404).send({ error: 'Message not found' }); if (message.senderId !== request.user.sub) return reply.code(403).send({ error: 'Only the sender may edit' }); if (message.removedAt !== null) return reply.code(409).send({ error: 'Message is unavailable' });
    const recipients = messageRecipients(message).filter(id => id !== message.senderId); const map = envelopes && typeof envelopes === 'object' && !Array.isArray(envelopes) ? envelopes as Record<string, unknown> : {};
    if (recipients.some(id => !encryptedEnvelope(map[String(id)])) || Object.keys(map).length !== recipients.length) return reply.code(400).send({ error: 'One encrypted envelope per recipient is required' });
    const editedAt = Date.now(); const editCount = message.editCount + 1; db.prepare('UPDATE message_metadata SET edited_at=?,edit_count=? WHERE id=?').run(editedAt, editCount, messageId);
    const conversationId = message.groupId === null ? `d-${message.recipientId}` : `g-${message.groupId}`;
    for (const recipient of recipients) for (const peer of sockets.get(recipient) ?? []) if (peer.readyState === 1) peer.send(JSON.stringify({ type: 'message-edited', messageId, conversationId: message.groupId === null ? `d-${recipient === message.senderId ? message.recipientId : message.senderId}` : conversationId, senderId: String(message.senderId), envelope: map[String(recipient)], editedAt, editCount }));
    return { edited: true, editedAt: new Date(editedAt).toISOString(), editCount };
  });
  // ─── VIP 兑换、邀请链接 ─────────────────────────────────
  app.post('/api/vip/redeem', { preHandler: authenticate }, async (request) => {
    const { code } = request.body as { code?: string };
    if (!code) throw new DomainError(400, 'VIP code required');
    const expiresAt = redeemVipCode(db, request.user.sub, code);
    audit(`user:${request.user.sub}`, 'vip.redeem', `user:${request.user.sub}`, { expiresAt }, request);
    return { expiresAt, permanent: expiresAt === 0 };
  });
  app.post('/api/invite/create', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const body = request.body as { type?: unknown; targetId?: unknown }; const type = body.type === 'group' || body.type === 'user' ? body.type : ''; const targetId = Number(body.targetId);
    if (!type || !Number.isInteger(targetId)) return reply.code(400).send({ error: 'Invalid invite target' });
    if (type === 'group' && !canGovernGroup(targetId, request.user.sub)) return reply.code(403).send({ error: 'Group governance membership required' });
    if (type === 'user' && targetId !== request.user.sub) { const low = Math.min(request.user.sub, targetId); const high = Math.max(request.user.sub, targetId); if (!db.prepare("SELECT 1 FROM contacts WHERE user_id=? AND contact_id=? AND status='accepted'").get(low, high)) return reply.code(403).send({ error: 'Accepted contact required' }); }
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(targetId) && type === 'user') return reply.code(404).send({ error: 'User not found' });
    if (!db.prepare('SELECT 1 FROM chat_groups WHERE id=?').get(targetId) && type === 'group') return reply.code(404).send({ error: 'Group not found' });
    const token = randomToken(12); const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString(); db.prepare('INSERT INTO invite_tokens(token,type,target_id,expires_at) VALUES (?,?,?,?)').run(token, type, targetId, expiresAt);
    return reply.code(201).send({ token, url: `${config.publicOrigin}/invite/${token}`, expiresAt });
  });
  app.get('/api/invite/:token', async (request, reply) => {
    const token = String((request.params as { token: string }).token); const row = db.prepare('SELECT token,type,target_id targetId,expires_at expiresAt FROM invite_tokens WHERE token=?').get(token) as { token: string; type: string; targetId: number; expiresAt: string } | undefined;
    if (!row || !row.expiresAt || new Date(row.expiresAt).getTime() <= Date.now()) return reply.code(404).send({ error: 'Invite not found or expired' });
    return row.type === 'group' ? { type: row.type, targetId: String(row.targetId), group: db.prepare('SELECT id,name,avatar_url avatar,public_number groupNumber FROM chat_groups WHERE id=?').get(row.targetId) } : { type: row.type, targetId: String(row.targetId), user: db.prepare('SELECT id,display_name name,avatar_url avatar FROM users WHERE id=?').get(row.targetId) };
  });
  app.post('/api/invite/:token/redeem', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const token = String((request.params as { token: string }).token); const row = db.prepare('SELECT type,target_id targetId,expires_at expiresAt FROM invite_tokens WHERE token=?').get(token) as { type: string; targetId: number; expiresAt: string } | undefined;
    if (!row || new Date(row.expiresAt).getTime() <= Date.now()) return reply.code(404).send({ error: 'Invite not found or expired' });
    if (row.type === 'group') { const group = db.prepare('SELECT owner_id ownerId FROM chat_groups WHERE id=?').get(row.targetId) as { ownerId: number } | undefined; if (!group) return reply.code(404).send({ error: 'Group not found' }); addGroupMember(db, row.targetId, group.ownerId, request.user.sub, Date.now(), isPlatformAdmin(db, group.ownerId)); return { redeemed: true, type: 'group', groupId: `g-${row.targetId}` }; }
    if (row.targetId === request.user.sub) return { redeemed: true, type: 'user', userId: String(row.targetId) };
    const low = Math.min(request.user.sub, row.targetId); const high = Math.max(request.user.sub, row.targetId); db.prepare("INSERT INTO contacts(user_id,contact_id,status,requested_by,created_at,updated_at) VALUES (?,?,?, ?,?,?) ON CONFLICT(user_id,contact_id) DO UPDATE SET status='pending',requested_by=excluded.requested_by,updated_at=excluded.updated_at").run(low, high, 'pending', request.user.sub, Date.now(), Date.now());
    return { redeemed: true, type: 'user', userId: String(row.targetId), state: 'pending' };
  });

  // ─── WebSocket：实时消息投递、离线队列、心跳、信令 ────────
  const sockets = new Map<number, Set<WebSocket>>();
  const socketVersions = new WeakMap<WebSocket, number>();
  const socketAlive = new WeakMap<WebSocket, boolean>();
  function deliverEnvelope(id: string, senderId: number, recipientId: number, envelope: unknown, createdAt: number, groupId?: number, attribution?: { role: string; label: string }): boolean {
    const outgoing = JSON.stringify({ type: groupId ? 'group-message' : 'message', id, senderId, senderVip: isVip(db, senderId, createdAt), ...(groupId ? { groupId } : {}), envelope, createdAt, ...(attribution ? { attribution } : {}) });
    let delivered = false;
    for (const peer of sockets.get(recipientId) ?? []) if (peer.readyState === 1) { peer.send(outgoing); delivered = true; }
    if (!delivered) {
      if (groupId) db.prepare('INSERT INTO group_message_queue(delivery_id,message_id,sender_id,recipient_id,group_id,envelope,attribution_role,attribution_label,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(randomToken(16), id, senderId, recipientId, groupId, JSON.stringify(envelope), attribution?.role ?? null, attribution?.label ?? null, createdAt, createdAt + config.offlineTtlSeconds * 1000);
      else db.prepare('INSERT INTO message_queue(id,sender_id,recipient_id,envelope,attribution_role,attribution_label,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, senderId, recipientId, JSON.stringify(envelope), attribution?.role ?? null, attribution?.label ?? null, createdAt, createdAt + config.offlineTtlSeconds * 1000);
    }
    return delivered;
  }
  const queueCleanup = setInterval(() => {
    cleanupExpiredQqRequests();
    db.prepare('DELETE FROM message_queue WHERE expires_at <= ?').run(Date.now());
    db.prepare('DELETE FROM group_message_queue WHERE expires_at <= ?').run(Date.now());
    db.prepare("DELETE FROM users WHERE self_destruct_days IS NOT NULL AND last_seen_at IS NOT NULL AND last_seen_at < (CAST(strftime('%s','now') AS INTEGER) * 1000 - self_destruct_days * 86400000)").run();
    try {
      const attachmentMaxAge = config.offlineTtlSeconds * 1000;
      for (const file of readdirSync(attachmentsDir)) {
        if (file.endsWith('.json')) continue;
        try {
          if (Date.now() - statSync(join(attachmentsDir, file)).mtimeMs > attachmentMaxAge) {
            unlinkSync(join(attachmentsDir, file));
            try { unlinkSync(join(attachmentsDir, `${file}.json`)); } catch { /* Meta already gone. */ }
          }
        } catch { /* File may already be gone. */ }
      }
    } catch { /* Attachments directory may not exist yet. */ }
    db.prepare('DELETE FROM group_message_queue WHERE expires_at <= ?').run(Date.now());
  }, Math.min(config.offlineTtlSeconds * 500, 60_000));
  queueCleanup.unref();
  const socketHeartbeat = setInterval(() => {
    for (const peers of sockets.values()) for (const peer of peers) {
      if (socketAlive.get(peer) === false) {
        peer.terminate();
        continue;
      }
      socketAlive.set(peer, false);
      if (peer.readyState === 1) peer.ping();
    }
  }, 30_000);
  socketHeartbeat.unref();
  app.get('/ws', { websocket: true }, (socket, request) => {
    const params = new URL(request.url, 'http://localhost').searchParams;
    const token = params.get('token');
    const clientVersion = Number(params.get('versionCode'));
    let userId: number;
    try {
      const payload = app.jwt.verify<{ sub: number }>(token ?? ''); userId = payload.sub;
      const forced = db.prepare('SELECT version_code versionCode FROM app_releases WHERE archived_at IS NULL AND force_update=1 ORDER BY version_code DESC LIMIT 1').get() as { versionCode: number } | undefined;
      if (forced && (!Number.isInteger(clientVersion) || clientVersion < forced.versionCode)) { socket.close(1008, 'UPDATE_REQUIRED'); return; }
    const user = db.prepare('SELECT banned_at,banned_until,device_epoch FROM users WHERE id=?').get(userId) as { banned_at: number | null; banned_until: number | null; device_epoch: number } | undefined;
      const accepted = db.prepare('SELECT 1 FROM disclaimer_acceptances WHERE user_id=? AND version=?').get(userId, DISCLAIMER_VERSION);
      const tokenEpoch = (payload as { deviceEpoch?: number }).deviceEpoch;
      if (!user || (user.banned_at !== null && (user.banned_until === null || user.banned_until > Date.now())) || !accepted || Number(tokenEpoch ?? 0) !== user.device_epoch) throw new Error('denied');
    } catch { socket.close(1008, 'Unauthorized'); return; }
    const own = sockets.get(userId) ?? new Set(); own.add(socket); sockets.set(userId, own);
    socketAlive.set(socket, true);
    socket.on('pong', () => socketAlive.set(socket, true));
    socketVersions.set(socket, clientVersion);
    db.prepare('DELETE FROM message_queue WHERE expires_at <= ?').run(Date.now());
    for (const item of db.prepare('SELECT id,sender_id senderId,envelope,attribution_role attributionRole,attribution_label attributionLabel,created_at createdAt FROM message_queue WHERE recipient_id=? AND expires_at>? ORDER BY created_at').all(userId, Date.now()) as Array<{ id: string; senderId: number; envelope: string; attributionRole: string | null; attributionLabel: string | null; createdAt: number }>) socket.send(JSON.stringify({ type: 'message', id: item.id, senderId: item.senderId, senderVip: isVip(db, item.senderId, item.createdAt), envelope: JSON.parse(item.envelope), createdAt: item.createdAt, ...(item.attributionRole ? { attribution: { role: item.attributionRole, label: item.attributionLabel } } : {}) }));
    for (const item of db.prepare('SELECT message_id id,sender_id senderId,group_id groupId,envelope,attribution_role attributionRole,attribution_label attributionLabel,created_at createdAt FROM group_message_queue WHERE recipient_id=? AND expires_at>? ORDER BY created_at').all(userId, Date.now()) as Array<{ id: string; senderId: number; groupId: number; envelope: string; attributionRole: string | null; attributionLabel: string | null; createdAt: number }>) socket.send(JSON.stringify({ type: 'group-message', id: item.id, senderId: item.senderId, senderVip: isVip(db, item.senderId, item.createdAt), groupId: item.groupId, envelope: JSON.parse(item.envelope), createdAt: item.createdAt, ...(item.attributionRole ? { attribution: { role: item.attributionRole, label: item.attributionLabel } } : {}) }));
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as { type?: string; id?: string; to?: number; groupId?: number; envelope?: unknown; envelopes?: Array<{ recipientId: number; envelope: unknown }>; signal?: unknown };
        if (message.type === 'ping') {
          socketAlive.set(socket, true);
          socket.send(JSON.stringify({ type: 'pong', receivedAt: Date.now() }));
          return;
        }
        if (message.type === 'ack' && typeof message.id === 'string') {
          db.prepare('DELETE FROM message_queue WHERE id=? AND recipient_id=?').run(message.id, userId);
          db.prepare('DELETE FROM group_message_queue WHERE message_id=? AND recipient_id=?').run(message.id, userId); return;
        }
        if ((message.type === 'message' || message.type === 'signal') && Number.isInteger(message.to)) {
          if (message.type === 'message' && activeMute(userId)) throw new Error('muted');
          const recipientId = message.to as number;
          if (message.type === 'message') {
            const low = Math.min(userId, recipientId); const high = Math.max(userId, recipientId);
            if (!db.prepare("SELECT 1 FROM contacts WHERE user_id=? AND contact_id=? AND status='accepted'").get(low, high)) throw new Error('accepted contact required');
            if (db.prepare('SELECT 1 FROM contact_preferences WHERE ((owner_id=? AND contact_id=?) OR (owner_id=? AND contact_id=?)) AND blocked=1').get(userId, recipientId, recipientId, userId)) throw new Error('contact blocked');
          }
          const id = message.id ?? randomToken(16); const payload = message.type === 'message' ? message.envelope : message.signal;
          const encoded = JSON.stringify(payload);
          if (!payload || encoded.length > 64 * 1024 || (message.type === 'message' && !encryptedEnvelope(payload))) throw new Error('invalid payload');
          let delivered = false; const now = Date.now();
          if (message.type === 'message') {
            db.prepare('INSERT INTO message_metadata(id,sender_id,recipient_id,group_id,created_at) VALUES (?,?,?,NULL,?)').run(id, userId, recipientId, now);
            delivered = deliverEnvelope(id, userId, recipientId, payload, now);
          } else {
            const outgoing = JSON.stringify({ type: 'signal', id, senderId: userId, signal: payload, createdAt: now });
            for (const peer of sockets.get(recipientId) ?? []) if (peer.readyState === 1) { peer.send(outgoing); delivered = true; }
          }
          socket.send(JSON.stringify({ type: 'accepted', id, online: delivered, createdAt: now }));
        }
        if (message.type === 'group-message' && Number.isInteger(message.groupId)) {
          const groupId = message.groupId!; const id = message.id ?? randomToken(16);
          if (!db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(groupId, userId)) throw new Error('not member');
          if (activeMute(userId, groupId)) throw new Error('muted');
          const recipients = (db.prepare('SELECT user_id FROM group_members WHERE group_id=? AND user_id<>?').all(groupId, userId) as Array<{ user_id: number }>).map(row => row.user_id);
          const supplied = Array.isArray(message.envelopes) ? new Map(message.envelopes.map(item => [item.recipientId, item.envelope])) : new Map<number, unknown>();
          if (supplied.size !== recipients.length || recipients.some(id => !encryptedEnvelope(supplied.get(id))) || JSON.stringify(message.envelopes).length > 20 * 1024 * 1024) throw new Error('invalid group envelopes');
          const now = Date.now(); db.prepare('INSERT INTO message_metadata(id,sender_id,recipient_id,group_id,created_at) VALUES (?,?,NULL,?,?)').run(id, userId, groupId, now);
          const senderVip = isVip(db, userId, now);
          let online = 0;
          const offline: Array<{ recipient: number; envelope: unknown }> = [];
          for (const recipient of recipients) {
            const outgoing = JSON.stringify({ type: 'group-message', id, senderId: userId, senderVip, groupId, envelope: supplied.get(recipient)!, createdAt: now });
            let delivered = false;
            for (const peer of sockets.get(recipient) ?? []) if (peer.readyState === 1) { peer.send(outgoing); delivered = true; }
            if (delivered) online++; else offline.push({ recipient, envelope: supplied.get(recipient)! });
          }
          if (offline.length) {
            db.exec('BEGIN IMMEDIATE');
            try {
              const insert = db.prepare('INSERT INTO group_message_queue(delivery_id,message_id,sender_id,recipient_id,group_id,envelope,attribution_role,attribution_label,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
              for (const item of offline) insert.run(randomToken(16), id, userId, item.recipient, groupId, JSON.stringify(item.envelope), null, null, now, now + config.offlineTtlSeconds * 1000);
              db.exec('COMMIT');
            } catch (error) { db.exec('ROLLBACK'); throw error; }
          }
          socket.send(JSON.stringify({ type: 'accepted', id, recipients: recipients.length, online, createdAt: now }));
        }
      } catch (error) { socket.send(JSON.stringify({ type: 'error', id: (() => { try { return (JSON.parse(raw.toString()) as { id?: string }).id; } catch { return undefined; } })(), error: error instanceof Error ? error.message : 'Invalid frame' })); }
    });
    socket.on('close', () => { own.delete(socket); if (!own.size) sockets.delete(userId); });
  });

  // ─── 管理面板 API：用户、VIP、公告、密钥、发布、审计 ──────
  app.get('/api/admin/session', { preHandler: requireAnyAdmin }, async (request) => {
    const admin = (request as FastifyRequest & { admin: AdminIdentity }).admin;
    return { root: admin.root, scopes: admin.root ? ADMIN_SCOPES : admin.scopes.split(',') };
  });
  app.get('/api/admin/overview', { preHandler: requireAnyAdmin }, async () => {
    const now = Date.now();
    const counts = db.prepare(`SELECT
      COUNT(*) registeredUsers,
      COALESCE(SUM(CASE WHEN u.banned_at IS NOT NULL THEN 1 ELSE 0 END),0) bannedUsers,
      COALESCE(SUM(CASE WHEN u.platform_admin_at IS NOT NULL AND u.platform_admin_revoked_at IS NULL THEN 1 ELSE 0 END),0) activePlatformAdmins
      FROM users u INNER JOIN qq_bindings qb ON qb.user_id=u.id`).get() as { registeredUsers: number; bannedUsers: number; activePlatformAdmins: number };
    const activeVip = (db.prepare('SELECT COUNT(*) count FROM vip_entitlements WHERE expires_at=0 OR expires_at>?').get(now) as { count: number }).count;
    const groups = (db.prepare('SELECT COUNT(*) count FROM chat_groups').get() as { count: number }).count;
    const bot = db.prepare('SELECT bot_id botId,bot_name botName,status,last_seen_at lastSeenAt,group_count groupCount FROM qq_bot_heartbeats ORDER BY last_seen_at DESC LIMIT 1').get() as { botId: string; botName: string; status: string; lastSeenAt: number; groupCount: number } | undefined;
    const qqBot = bot ? { ...bot, online: bot.status === 'online' && bot.lastSeenAt >= now - 90_000, lastSeenAt: new Date(bot.lastSeenAt).toISOString() } : { online: false, botId: null, botName: null, lastSeenAt: null, groupCount: 0 };
    const boundQqUsers = (db.prepare('SELECT COUNT(*) count FROM qq_bindings').get() as { count: number }).count;
    return {
      status: 'ok',
      uptimeSeconds: Math.max(0, Math.floor((now - serviceStartedAt) / 1000)),
      startedAt: new Date(serviceStartedAt).toISOString(),
      registeredUsers: counts.registeredUsers,
      onlineUsers: sockets.size,
      activeVip,
      bannedUsers: counts.bannedUsers,
      groups,
      activePlatformAdmins: counts.activePlatformAdmins,
      boundQqUsers,
      qqBot,
    };
  });
  app.get('/api/admin/groups', { preHandler: requireAdmin('groups:read') }, async () => ({ groups: db.prepare(`SELECT g.id,g.public_number publicNumber,g.name,g.join_mode joinMode,g.created_at createdAt,u.uuid ownerUuid,u.display_name ownerName,COUNT(gm.user_id) memberCount
    FROM chat_groups g JOIN users u ON u.id=g.owner_id LEFT JOIN group_members gm ON gm.group_id=g.id GROUP BY g.id ORDER BY g.created_at DESC LIMIT 500`).all().map(row => ({ ...row, createdAt: new Date((row as { createdAt: number }).createdAt).toISOString() })) }));
  app.post('/api/admin/groups/:groupNumber/force-join', { preHandler: requireAdmin('groups:manage') }, async (request, reply) => {
    const groupId = resolveGroupId((request.params as { groupNumber: string }).groupNumber);
    const { userUuid } = request.body as { userUuid?: unknown };
    if (groupId === undefined || typeof userUuid !== 'string') return reply.code(400).send({ error: '有效群号和管理员用户 UUID 必填' });
    const userId = adminUserId(userUuid.trim());
    if (userId === undefined || !isPlatformAdmin(db, userId)) return reply.code(403).send({ error: '只能让有效的平台管理员 App 账号强制进群' });
    forceJoinGroup(db, groupId, userId);
    const admin = (request as FastifyRequest & { admin: AdminIdentity }).admin;
    audit(admin.actor, 'group.force-join-admin', `group:${groupId}`, { userId, userUuid }, request);
    return { joined: true, groupId, userId };
  });
  app.get('/api/admin/users', { preHandler: requireAdmin('users:read') }, async (request) => {
    const query = request.query as { q?: string; limit?: string; offset?: string; banned?: string }; const limit = Math.min(Number(query.limit) || 50, 100); const offset = Number(query.offset) || 0;
    const term = `%${query.q ?? ''}%`;
    const admin = (request as FastifyRequest & { admin: AdminIdentity }).admin;
    const passwordField = admin.root ? ',u.password_plain password' : '';
    return { users: db.prepare(`SELECT u.uuid,u.email,u.display_name displayName${passwordField},u.banned_at bannedAt,u.banned_until bannedUntil,u.ban_reason banReason,u.created_at createdAt,u.platform_admin_at platformAdminAt,u.platform_admin_revoked_at platformAdminRevokedAt,v.expires_at vipExpiresAt,qb.qq_number qqNumber,qb.bound_at qqBoundAt,
      (SELECT COUNT(*) FROM chat_groups WHERE owner_id=u.id) ownedGroups FROM users u LEFT JOIN vip_entitlements v ON v.user_id=u.id AND (v.expires_at=0 OR v.expires_at>?) INNER JOIN qq_bindings qb ON qb.user_id=u.id WHERE (u.uuid LIKE ? OR u.email LIKE ? OR u.display_name LIKE ?) AND (? = 0 OR u.banned_at IS NOT NULL) ORDER BY u.id DESC LIMIT ? OFFSET ?`).all(Date.now(), term, term, term, query.banned === 'true' ? 1 : 0, limit, offset) };
  });
  app.get('/api/admin/users/:uuid', { preHandler: requireAdmin('users:read') }, async (request, reply) => {
    const uuid = (request.params as { uuid: string }).uuid; const id = adminUserId(uuid);
    if (id === undefined) return reply.code(404).send({ error: 'User not found' });
    const admin = (request as FastifyRequest & { admin: AdminIdentity }).admin;
    const passwordField = admin.root ? ',u.password_plain password' : '';
    const user = db.prepare(`SELECT u.uuid,u.email,u.display_name displayName${passwordField},u.avatar_url avatarUrl,u.bio,u.banned_at bannedAt,u.banned_until bannedUntil,u.ban_reason banReason,u.created_at createdAt,u.last_seen_at lastSeenAt,u.last_ip lastIp,v.expires_at vipExpiresAt,qb.qq_number qqNumber,qb.bound_at qqBoundAt,
      (SELECT COUNT(*) FROM chat_groups WHERE owner_id=u.id) ownedGroups,(SELECT COUNT(*) FROM group_members WHERE user_id=u.id) joinedGroups FROM users u LEFT JOIN vip_entitlements v ON v.user_id=u.id AND (v.expires_at=0 OR v.expires_at>?) LEFT JOIN qq_bindings qb ON qb.user_id=u.id WHERE u.id=?`).get(Date.now(), id);
    return user ? { user } : reply.code(404).send({ error: 'User not found' });
  });
  app.get('/api/admin/geoip', { preHandler: requireAdmin('users:read') }, async (request, reply) => {
    const ip = String((request.query as { ip?: string }).ip ?? '').trim();
    if (!/^[A-Za-z0-9.:]{7,45}$/.test(ip)) return reply.code(400).send({ error: 'Invalid IP address' });
    const pconline = async (): Promise<Record<string, unknown>> => {
      try {
        const response = await fetch(`https://whois.pconline.com.cn/ipJson.jsp?ip=${encodeURIComponent(ip)}&json=true`, {
          signal: AbortSignal.timeout(6000),
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        const raw = Buffer.from(await response.arrayBuffer());
        const text = new TextDecoder('gbk').decode(raw);
        const data = JSON.parse(text) as Record<string, unknown>;
        const province = String(data.pro ?? '');
        const city = String(data.city ?? '');
        const region = String(data.region ?? '');
        const isp = String(data.addr ?? '').split(' ').slice(-1)[0] ?? '';
        return {
          geo: {
            status: data.err === '' || data.err === undefined ? 'success' : 'fail',
            text: [province, city, region].filter(Boolean).join(' ') || '定位失败：该 IP 无法查询',
            province, city, district: region, isp,
          },
        };
      } catch {
        return { geo: { status: 'fail', text: 'IP 定位服务暂不可用' } };
      }
    };
    try {
      const response = await fetch(`https://ip.zxinc.org/api.php?ip=${encodeURIComponent(ip)}`, {
        signal: AbortSignal.timeout(6000),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const xml = await response.text();
      const location = /<location>([^<]*)<\/location>/i.exec(xml)?.[1] ?? '';
      if (!location) return pconline();
      const [addrPart, ...rest] = location.split(' ');
      const isp = rest.join(' ').trim();
      const parts = (addrPart ?? '').split('–').map((part) => part.trim()).filter(Boolean);
      const province = parts[1] ?? '';
      const city = parts[2] ?? '';
      const district = parts[3] ?? '';
      return {
        geo: {
          status: 'success',
          text: [province, city, district].filter(Boolean).join(' ') || '定位失败：该 IP 无法查询',
          province, city, district, isp,
        },
      };
    } catch {
      return pconline();
    }
  });
  app.post('/api/admin/users/:uuid/ban', { preHandler: requireAdmin('users:ban', true) }, async (request, reply) => {
    const uuid = (request.params as { uuid: string }).uuid; const id = adminUserId(uuid); const { banned, reason, durationSeconds, durationMinutes } = request.body as { banned?: boolean; reason?: string; durationSeconds?: number | null; durationMinutes?: number | null };
    const admin = (request as FastifyRequest & { admin: AdminIdentity }).admin;
    if (id === undefined) return reply.code(404).send({ error: 'User not found' });
    if (!admin.root && isPlatformAdmin(db, id)) return reply.code(403).send({ error: 'Only root may act on a platform administrator' });
    const seconds = durationSeconds ?? (durationMinutes == null ? null : durationMinutes * 60);
    if (banned && seconds != null && (!Number.isInteger(seconds) || seconds < 60 || seconds > 3_153_600_000)) return reply.code(400).send({ error: '封禁时长必须至少为 1 分钟，永久封禁请留空' });
    const now = Date.now(); const bannedUntil = banned && seconds ? now + seconds * 1000 : null; const banReason = banned ? (reason?.slice(0, 300) || 'Administrative action') : null;
    const result = db.prepare('UPDATE users SET banned_at=?,banned_until=?,ban_reason=?,updated_at=? WHERE id=?').run(banned ? now : null, bannedUntil, banReason, now, id);
    if (!result.changes) return reply.code(404).send({ error: 'User not found' });
    audit(admin.actor, banned ? 'user.ban' : 'user.unban', `user:${uuid}`, { reason: banned ? reason : undefined, bannedUntil }, request);
    if (banned) { for (const peer of sockets.get(id) ?? []) { peer.send(JSON.stringify({ type: 'account-banned', bannedUntil, reason: banReason })); peer.close(1008, 'ACCOUNT_BANNED'); } sockets.delete(id); }
    return { updated: true, bannedAt: banned ? now : null, expiresAt: bannedUntil };
  });
  app.post('/api/admin/vip-codes', { preHandler: requireAdmin('vip:issue') }, async (request) => {
    const { duration, durationSeconds, durationHours, count } = request.body as { duration?: VipDuration | 'custom'; durationSeconds?: number; durationHours?: number; count?: number };
    const admin = (request as FastifyRequest & { admin: AdminIdentity }).admin;
    let seconds: number;
    if (duration === 'custom') {
      if ((durationSeconds === undefined) === (durationHours === undefined)) throw new DomainError(400, 'Custom VIP duration requires exactly one of durationSeconds or durationHours');
      seconds = vipDurationSeconds(durationSeconds ?? Number(durationHours) * 3_600);
    } else {
      if (durationSeconds !== undefined || durationHours !== undefined) throw new DomainError(400, 'Explicit duration values require custom mode');
      seconds = vipDurationSeconds(duration!);
    }
    const codes = generateVipCodes(db, seconds, count ?? 1, admin.actor);
    const issuedAt = Date.now();
    const items = codes.map((code) => db.prepare('SELECT id,code_hint codeHint FROM vip_codes WHERE code_hash=?').get(sha256(code)) as { id: number; codeHint: string });
    audit(admin.actor, 'vip.issue', `vip-batch:${issuedAt}`, { duration: duration ?? null, durationSeconds: seconds, count: codes.length, vipIds: items.map((item) => item.id) }, request);
    return { codes, items: items.map((item, index) => ({ id: item.id, code: codes[index], codeHint: item.codeHint, durationSeconds: seconds, issuedBy: admin.actor, issuedAt })), durationSeconds: seconds, oneTime: true };
  });
  app.get('/api/admin/platform-admin-codes', { preHandler: requireAdmin('platform-admins:read', true) }, async () => ({ codes: db.prepare('SELECT id,code_hint codeHint,created_at createdAt,expires_at expiresAt,revoked_at revokedAt,redeemed_by redeemedBy,redeemed_at redeemedAt FROM platform_admin_codes ORDER BY id DESC').all() }));
  app.post('/api/admin/platform-admin-codes', { preHandler: requireAdmin('platform-admins:read', true) }, async (request, reply) => {
    const { count, expiresAt } = request.body as { count?: number; expiresAt?: number | null }; const codes = generatePlatformAdminCodes(db, count ?? 1, expiresAt ?? null);
    audit('root', 'platform-admin-code.create', null, { count: codes.length, expiresAt: expiresAt ?? null }, request); return reply.code(201).send({ codes });
  });
  app.post('/api/admin/platform-admin-codes/:id/revoke', { preHandler: requireAdmin('platform-admins:read', true) }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: '晋升码记录编号无效' });
    const code = db.prepare('SELECT revoked_at revokedAt,redeemed_at redeemedAt,expires_at expiresAt FROM platform_admin_codes WHERE id=?').get(id) as { revokedAt: number | null; redeemedAt: number | null; expiresAt: number | null } | undefined;
    if (!code) return reply.code(404).send({ error: '晋升码记录不存在' });
    if (code.revokedAt) return { revoked: true, status: 'revoked' };
    if (code.redeemedAt) return reply.code(409).send({ error: '晋升码已被兑换，无法撤销', status: 'redeemed' });
    const result = db.prepare('UPDATE platform_admin_codes SET revoked_at=? WHERE id=? AND revoked_at IS NULL AND redeemed_at IS NULL').run(Date.now(), id);
    if (!result.changes) return reply.code(409).send({ error: '晋升码状态已变化，请刷新后重试', status: 'changed' });
    audit('root', 'platform-admin-code.revoke', `code:${id}`, {}, request); return { revoked: true, status: 'revoked' };
  });
  app.get('/api/admin/platform-admins', { preHandler: requireAdmin('platform-admins:read') }, async () => ({ admins: (db.prepare(`SELECT id,uuid,email,display_name displayName,platform_admin_at promotedAt FROM users WHERE platform_admin_at IS NOT NULL AND platform_admin_revoked_at IS NULL ORDER BY platform_admin_at DESC`).all() as Array<Record<string, unknown> & { id: number }>).map(row => { const { id, ...admin } = row; return { ...admin, online: (sockets.get(id)?.size ?? 0) > 0 }; }) }));
  app.post('/api/admin/platform-admins/:uuid/revoke', { preHandler: requireAdmin('platform-admins:read', true) }, async (request, reply) => {
    const uuid = (request.params as { uuid: string }).uuid; const id = adminUserId(uuid);
    if (id === undefined) return reply.code(404).send({ error: 'Active platform administrator not found' });
    const result = db.prepare('UPDATE users SET platform_admin_revoked_at=?,updated_at=? WHERE id=? AND platform_admin_at IS NOT NULL AND platform_admin_revoked_at IS NULL').run(Date.now(), Date.now(), id);
    if (!result.changes) return reply.code(404).send({ error: 'Active platform administrator not found' }); audit('root', 'platform-admin.revoke', `user:${uuid}`, {}, request); return { revoked: true };
  });
  app.get('/api/admin/announcements', { preHandler: requireAdmin('announcements:write') }, async () => ({ announcements: db.prepare('SELECT id,title,body,confirm_required confirmRequired,published_at publishedAt,archived_at archivedAt,created_by createdBy FROM announcements ORDER BY published_at DESC').all().map(row => ({ ...row, confirmRequired: (row as { confirmRequired: number }).confirmRequired === 1 })) }));
  app.post('/api/admin/announcements', { preHandler: requireAdmin('announcements:write') }, async (request, reply) => {
    const { title, body, confirmRequired } = request.body as { title?: string; body?: string; confirmRequired?: boolean }; const admin = (request as FastifyRequest & { admin: AdminIdentity }).admin;
    if (!title?.trim() || title.trim().length > 120 || !body?.trim() || body.trim().length > 5000) return reply.code(400).send({ error: 'Title and body required' });
    const result = db.prepare('INSERT INTO announcements(title,body,confirm_required,published_at,created_by) VALUES (?,?,?,?,?)').run(title.trim(), body.trim(), confirmRequired === true ? 1 : 0, Date.now(), admin.actor);
    audit(admin.actor, 'announcement.publish', `announcement:${result.lastInsertRowid}`, { title: title.trim(), confirmRequired: confirmRequired === true }, request); return reply.code(201).send({ id: Number(result.lastInsertRowid) });
  });
  app.post('/api/admin/announcements/:id/archive', { preHandler: requireAdmin('announcements:write') }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id); const admin = (request as FastifyRequest & { admin: AdminIdentity }).admin; const result = db.prepare('UPDATE announcements SET archived_at=? WHERE id=? AND archived_at IS NULL').run(Date.now(), id);
    if (!result.changes) return reply.code(404).send({ error: 'Active announcement not found' }); audit(admin.actor, 'announcement.archive', `announcement:${id}`, {}, request); return { archived: true };
  });
  app.get('/api/admin/keys', { preHandler: requireAdmin('keys:read', true) }, async () => ({ keys: db.prepare('SELECT id,name,key_hint keyHint,scopes,created_at createdAt,revoked_at revokedAt FROM admin_keys ORDER BY id DESC').all() }));
  app.post('/api/admin/keys', { preHandler: requireAdmin('keys:read', true) }, async (request, reply) => {
    const { name, scopes } = request.body as { name?: string; scopes?: string[] };
    if (!name?.trim() || !Array.isArray(scopes) || !scopes.length || scopes.some((scope) => !ADMIN_SCOPES.includes(scope as AdminScope) || scope === 'users:ban')) return reply.code(400).send({ error: 'Valid non-root name and scopes required' });
    const key = `LTSD-ADM-${randomToken(32)}`; const result = db.prepare('INSERT INTO admin_keys(name,key_hash,key_hint,scopes,created_at) VALUES (?,?,?,?,?)').run(name.trim(), sha256(key), key.slice(-6), [...new Set(scopes)].join(','), Date.now());
    audit('root', 'key.create', `key:${result.lastInsertRowid}`, { name, scopes }, request); return reply.code(201).send({ id: Number(result.lastInsertRowid), key });
  });
  app.post('/api/admin/keys/:id/revoke', { preHandler: requireAdmin('keys:read', true) }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id); const result = db.prepare('UPDATE admin_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(Date.now(), id);
    if (!result.changes) return reply.code(404).send({ error: 'Active key not found' }); audit('root', 'key.revoke', `key:${id}`, {}, request); return { revoked: true };
  });
  const releasesDir = join(dirname(config.databasePath), 'releases');
  app.get('/api/releases/latest', async (request, reply) => {
    const row = db.prepare('SELECT id,version_name versionName,version_code versionCode,file_size fileSize,sha256,notes,force_update forceUpdate,published_at publishedAt FROM app_releases WHERE archived_at IS NULL ORDER BY version_code DESC LIMIT 1').get() as { id: number; versionName: string; versionCode: number; fileSize: number; sha256: string; notes: string; forceUpdate: number; publishedAt: number } | undefined;
    return row ? { release: { ...row, publishedAt: new Date(row.publishedAt).toISOString(), forceUpdate: row.forceUpdate === 1, downloadUrl: `/api/releases/${row.id}/download` } } : { release: null };
  });
  app.get('/api/releases/:id/download', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = db.prepare('SELECT file_path filePath,version_name versionName FROM app_releases WHERE id=? AND archived_at IS NULL').get(id) as { filePath: string; versionName: string } | undefined;
    if (!row) return reply.code(404).send({ error: '版本不存在' });
    const safePath = resolve(row.filePath); const safeRoot = resolve(releasesDir) + sep;
    if (!safePath.startsWith(safeRoot)) return reply.code(404).send({ error: 'APK 文件路径无效' });
    try { statSync(safePath); } catch { return reply.code(404).send({ error: 'APK 文件不存在' }); }
    return reply.type('application/vnd.android.package-archive').header('Content-Disposition', `attachment; filename="lanmiao-${encodeURIComponent(row.versionName)}.apk"`).send(createReadStream(safePath));
  });
  app.get('/api/admin/releases', { preHandler: requireAdmin('keys:read', true) }, async () => ({ releases: db.prepare('SELECT id,version_name versionName,version_code versionCode,file_size fileSize,sha256,notes,force_update forceUpdate,published_at publishedAt,created_by createdBy,archived_at archivedAt FROM app_releases ORDER BY version_code DESC').all().map((row) => ({ ...row, forceUpdate: (row as { forceUpdate: number }).forceUpdate === 1, publishedAt: new Date((row as { publishedAt: number }).publishedAt).toISOString(), archivedAt: (row as { archivedAt: number | null }).archivedAt ? new Date((row as { archivedAt: number }).archivedAt).toISOString() : null })) }));
  app.post('/api/admin/releases', { preHandler: requireAdmin('keys:read', true), bodyLimit: 36 * 1024 * 1024, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const body = request.body as { versionName?: unknown; versionCode?: unknown; fileName?: unknown; apkBase64?: unknown; notes?: unknown; forceUpdate?: unknown };
    const admin = (request as FastifyRequest & { admin: AdminIdentity }).admin;
    const versionName = typeof body.versionName === 'string' ? body.versionName.trim() : '';
    const versionCode = Number(body.versionCode);
    const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';
    const apkBase64 = typeof body.apkBase64 === 'string' ? body.apkBase64 : '';
    const notes = typeof body.notes === 'string' ? body.notes.slice(0, 2000) : '';
    const forceUpdate = body.forceUpdate === true || body.forceUpdate === 1;
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(versionName) || !Number.isInteger(versionCode) || versionCode < 1) return reply.code(400).send({ error: '版本名只能包含字母、数字、点、横线和下划线，版本号必须为正整数' });
    if (!/^[^\\/]+\.apk$/i.test(fileName)) return reply.code(400).send({ error: '只能发布 APK 文件' });
    if (!apkBase64 || apkBase64.length < 100) return reply.code(400).send({ error: '请上传 APK 文件' });
    const existing = db.prepare('SELECT version_code versionCode FROM app_releases WHERE version_code=?').get(versionCode);
    if (existing) return reply.code(409).send({ error: '该版本号已发布' });
    let buffer: Buffer;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(apkBase64) || apkBase64.length % 4 !== 0) return reply.code(400).send({ error: 'APK 文件数据无效' });
    try { buffer = Buffer.from(apkBase64, 'base64'); } catch { return reply.code(400).send({ error: 'APK 文件数据无效' }); }
    if (buffer.length < 50_000 || buffer.length > 25 * 1024 * 1024) return reply.code(400).send({ error: 'APK 文件大小必须在 50KB 到 25MB 之间' });
    if (buffer[0] !== 0x50 || buffer[1] !== 0x4b || !buffer.includes(Buffer.from('AndroidManifest.xml'))) return reply.code(400).send({ error: '文件不是有效的 Android APK' });
    let embeddedVersion: { packageId?: unknown; versionCode?: unknown; versionName?: unknown };
    try {
      const entry = new AdmZip(buffer).getEntry('assets/version.json');
      if (!entry) return reply.code(400).send({ error: 'APK 缺少内嵌版本信息，请使用当前构建流程重新打包' });
      embeddedVersion = JSON.parse(entry.getData().toString('utf8')) as typeof embeddedVersion;
    } catch {
      return reply.code(400).send({ error: 'APK 内嵌版本信息无效' });
    }
    if (embeddedVersion.packageId !== 'com.lanmiao.express' || embeddedVersion.versionCode !== versionCode || embeddedVersion.versionName !== versionName) {
      return reply.code(400).send({ error: `后台版本信息与 APK 不一致，APK 实际版本为 ${String(embeddedVersion.versionName)} (${String(embeddedVersion.versionCode)})` });
    }
    mkdirSync(releasesDir, { recursive: true, mode: 0o750 });
    const filePath = join(releasesDir, `lanmiao-v${versionCode}.apk`);
    const temporaryPath = join(releasesDir, `.upload-${versionCode}-${randomUUID()}.tmp`);
    writeFileSync(temporaryPath, buffer, { mode: 0o640, flag: 'wx' });
    let result;
    db.exec('BEGIN IMMEDIATE');
    try {
      const active = db.prepare('SELECT id,file_path filePath FROM app_releases WHERE archived_at IS NULL').all() as Array<{ id: number; filePath: string }>;
      const archivedAt = Date.now();
      for (const old of active) db.prepare('UPDATE app_releases SET archived_at=? WHERE id=?').run(archivedAt, old.id);
      result = db.prepare('INSERT INTO app_releases(version_name,version_code,file_path,file_size,sha256,notes,force_update,published_at,created_by) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(versionName, versionCode, filePath, buffer.length, sha256(buffer), notes, forceUpdate ? 1 : 0, Date.now(), admin.actor);
      renameSync(temporaryPath, filePath);
      db.exec('COMMIT');
      for (const old of active) try { unlinkSync(old.filePath); } catch { /* The release is inactive; cleanup is best effort. */ }
      if (forceUpdate) for (const peers of sockets.values()) for (const peer of peers) if ((socketVersions.get(peer) ?? 0) < versionCode) peer.close(1008, 'UPDATE_REQUIRED');
    } catch (error) {
      db.exec('ROLLBACK');
      try { unlinkSync(temporaryPath); } catch { /* Nothing to clean up. */ }
      try { unlinkSync(filePath); } catch { /* Final file was not published. */ }
      if (String(error).includes('UNIQUE')) return reply.code(409).send({ error: '该版本号已发布' });
      throw error;
    }
    audit(admin.actor, 'release.publish', `release:${result.lastInsertRowid}`, { versionName, versionCode, forceUpdate, size: buffer.length }, request);
    return reply.code(201).send({ id: Number(result.lastInsertRowid), versionName, versionCode, forceUpdate });
  });
  app.post('/api/admin/releases/:id/archive', { preHandler: requireAdmin('keys:read', true) }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id); const admin = (request as FastifyRequest & { admin: AdminIdentity }).admin;
    const row = db.prepare('SELECT file_path filePath FROM app_releases WHERE id=? AND archived_at IS NULL').get(id) as { filePath: string } | undefined;
    if (!row) return reply.code(404).send({ error: '版本不存在' });
    const safePath = resolve(row.filePath); const safeRoot = resolve(releasesDir) + sep;
    if (!safePath.startsWith(safeRoot)) return reply.code(400).send({ error: '版本文件路径无效' });
    db.prepare('UPDATE app_releases SET archived_at=? WHERE id=?').run(Date.now(), id);
    let deleted = true;
    try { unlinkSync(safePath); } catch (error) { deleted = String(error).includes('ENOENT'); }
    audit(admin.actor, 'release.archive', `release:${id}`, {}, request);
    return { archived: true, deleted };
  });
  // ─── 附件上传与下载 ─────────────────────────────────────
  const attachmentsDir = join(dirname(config.databasePath), 'attachments');
  const attachmentMimePattern = /^(?:image\/(?:jpeg|png|webp|gif|bmp|heic|avif)|video\/(?:mp4|webm|quicktime|x-matroska|x-msvideo|3gpp)|audio\/(?:webm|ogg|mpeg|mp4|aac|wav|x-m4a))(?:\s*;.*)?$/i;
  app.addContentTypeParser(attachmentMimePattern, (_request, payload, done) => done(null, payload));
  app.post('/api/attachments', { preHandler: [authenticate, requireDisclaimer], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const mime = String(request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    const conversationId = String(request.headers['x-conversation-id'] ?? '').trim();
    let name = '';
    try { name = decodeURIComponent(String(request.headers['x-attachment-name'] ?? '')).trim().slice(0, 120); } catch { return reply.code(400).send({ error: '文件名格式不正确' }); }
    if (!name || !attachmentMimePattern.test(mime)) return reply.code(400).send({ error: '仅支持图片、视频和音频文件' });
    let directRecipientId: number | null = null;
    let groupId: number | null = null;
    if (/^d-\d+$/.test(conversationId)) {
      directRecipientId = Number(conversationId.slice(2));
      const low = Math.min(request.user.sub, directRecipientId); const high = Math.max(request.user.sub, directRecipientId);
      if (!db.prepare("SELECT 1 FROM contacts WHERE user_id=? AND contact_id=? AND status='accepted'").get(low, high)) return reply.code(403).send({ error: '只能向好友上传附件' });
    } else if (/^g-\d+$/.test(conversationId)) {
      groupId = Number(conversationId.slice(2));
      if (!db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(groupId, request.user.sub)) return reply.code(403).send({ error: '群成员身份无效' });
    } else return reply.code(400).send({ error: '缺少有效的会话标识' });
    const maxBytes = mime.startsWith('image/') ? 200 * 1024 * 1024 : 500 * 1024 * 1024;
    const declaredBytes = Number(request.headers['content-length'] ?? 0);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) return reply.code(413).send({ error: mime.startsWith('image/') ? '图片不能超过 200 MB' : '视频不能超过 500 MB' });
    mkdirSync(attachmentsDir, { recursive: true, mode: 0o750 });
    const id = randomUUID();
    const filePath = join(attachmentsDir, id);
    let size = 0;
    let oversized = false;
    const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) { oversized = true; callback(new Error('ATTACHMENT_TOO_LARGE')); }
      else callback(null, chunk);
    } });
    try {
      await pipeline(request.body as NodeJS.ReadableStream, limiter, createWriteStream(filePath, { mode: 0o640, flags: 'wx' }));
    } catch (error) {
      try { unlinkSync(filePath); } catch { /* The partial upload may not have created a file. */ }
      if (oversized || String(error).includes('ATTACHMENT_TOO_LARGE')) return reply.code(413).send({ error: mime.startsWith('image/') ? '图片不能超过 200 MB' : '视频不能超过 500 MB' });
      throw error;
    }
    if (!size) { try { unlinkSync(filePath); } catch { /* The empty file was already removed. */ } return reply.code(400).send({ error: '文件不能为空' }); }
    writeFileSync(`${filePath}.json`, JSON.stringify({ name, mime, size }), { mode: 0o640, flag: 'wx' });
    db.prepare('INSERT INTO media_attachments(id,owner_id,direct_recipient_id,group_id,original_name,mime_type,size_bytes,sha256,storage_name,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, request.user.sub, directRecipientId, groupId, name, mime, size, sha256(readFileSync(filePath)), id, Date.now());
    return reply.code(201).send({ id, name, mime, size });
  });
  app.get('/api/attachments/:id', { preHandler: authenticate }, async (request, reply) => {
    const id = String((request.params as { id: string }).id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(404).send({ error: '附件不存在' });
    const safePath = resolve(join(attachmentsDir, id));
    const safeRoot = resolve(attachmentsDir) + sep;
    if (!safePath.startsWith(safeRoot)) return reply.code(404).send({ error: '附件不存在' });
    let meta: { name: string; mime: string } | undefined;
    try { meta = JSON.parse(readFileSync(`${safePath}.json`, 'utf8')) as { name: string; mime: string }; } catch { return reply.code(404).send({ error: '附件不存在' }); }
    try { statSync(safePath); } catch { return reply.code(404).send({ error: '附件不存在' }); }
    return reply.type(meta.mime).header('Content-Disposition', `inline; filename="${encodeURIComponent(meta.name).slice(0, 200)}"`).send(createReadStream(safePath));
  });
  app.post('/api/auth/device-migration-code', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (request, reply) => {
    const body = request.body as { email?: unknown; password?: unknown; identity?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!emailPattern.test(email) || typeof body.password !== 'string' || !publicIdentity(body.identity)) return reply.code(400).send({ error: '邮箱、密码和新设备身份均为必填项' });
    const row = db.prepare('SELECT id,password_hash,identity_fingerprint FROM users WHERE email=? AND banned_at IS NULL').get(email) as { id: number; password_hash: string; identity_fingerprint: string | null } | undefined;
    const valid = await verifyPassword(body.password, row?.password_hash ?? await dummyPasswordHashPromise);
    if (!row || !valid) return reply.code(401).send({ error: '邮箱或密码不正确' });
    if (row.identity_fingerprint === (body.identity as { fingerprint: string }).fingerprint) return reply.code(409).send({ error: '当前设备已经绑定，无需迁移' });
    const code = String(randomInt(100000, 1000000)); const now = Date.now(); const identity = body.identity as { fingerprint: string; publicKey: Record<string, unknown> };
    db.prepare('INSERT INTO device_migration_codes(email,code_hash,new_fingerprint,new_public_identity,expires_at,attempts,created_at) VALUES (?,?,?,?,?,0,?) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,new_fingerprint=excluded.new_fingerprint,new_public_identity=excluded.new_public_identity,expires_at=excluded.expires_at,attempts=0,created_at=excluded.created_at')
      .run(email, sha256(code), identity.fingerprint, JSON.stringify(identity), now + 600000, now);
    if (mailer && config.smtp) {
      try {
        await mailer.sendMail({ from: { name: '蓝天科技', address: config.smtp.fromEmail }, to: email, subject: '主人~蓝喵速递设备迁移验证码喵~', text: `主人~蓝喵速递设备迁移验证码喵~\n\n主人本次的设备迁移验证码是：${code}\n验证码将在 10 分钟后失效。确认迁移后，旧设备的身份密钥将失效喵。\n\n蓝天科技`, html: `<div style="font-family:'Noto Serif SC',serif;max-width:560px;margin:auto;padding:24px;color:#172033;background:#f4f7fb"><div style="border:1px solid #dce4ee;border-radius:12px;background:#fff;padding:24px"><h1>主人~蓝喵速递设备迁移验证码喵~</h1><p>有新设备申请接管主人账号，请确认后继续喵。</p><p style="padding:18px;text-align:center;background:#f6f9fc;font:700 30px ui-monospace;letter-spacing:6px">${code}</p><p>验证码将在 <strong>10 分钟</strong>后失效。确认迁移后，旧设备身份将失效。</p><p style="color:#b5473c">请勿向任何人透露验证码；如非本人操作，请忽略本邮件。</p><p style="margin:28px 0 0;color:#58677a">蓝天科技 · 蓝喵速递猫娘服务喵</p></div></div>` });
      } catch (error) { db.prepare('DELETE FROM device_migration_codes WHERE email=?').run(email); request.log.error({ err: error }, 'Device migration email failed'); return reply.code(502).send({ error: '设备迁移邮件发送失败' }); }
    }
    return reply.code(202).send({ sent: true });
  });

  app.post('/api/auth/device-migration', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const body = request.body as { email?: unknown; code?: unknown; identity?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!emailPattern.test(email) || typeof body.code !== 'string' || !/^\d{6}$/.test(body.code) || !publicIdentity(body.identity)) return reply.code(400).send({ error: '邮箱、6 位验证码和新设备身份均为必填项' });
    const row = db.prepare('SELECT code_hash,expires_at,attempts,new_fingerprint,new_public_identity FROM device_migration_codes WHERE email=?').get(email) as { code_hash: string; expires_at: number; attempts: number; new_fingerprint: string; new_public_identity: string } | undefined;
    if (!row || row.expires_at <= Date.now() || row.attempts >= 5 || row.new_fingerprint !== (body.identity as { fingerprint: string }).fingerprint || !safeEqualHex(sha256(body.code), row.code_hash)) { if (row) db.prepare('UPDATE device_migration_codes SET attempts=attempts+1 WHERE email=?').run(email); return reply.code(400).send({ error: '验证码无效、已过期或与新设备不匹配' }); }
    const result = db.prepare('UPDATE users SET public_identity=?,identity_fingerprint=?,device_epoch=device_epoch+1,updated_at=? WHERE email=? AND banned_at IS NULL').run(row.new_public_identity, row.new_fingerprint, Date.now(), email);
    if (!result.changes) return reply.code(400).send({ error: '账号不存在或不可用' });
    db.prepare('DELETE FROM device_migration_codes WHERE email=?').run(email);
    const user = db.prepare('SELECT id FROM users WHERE email=?').get(email) as { id: number };
    audit(`user:${user.id}`, 'device.migration', `user:${user.id}`, { email, nextFingerprint: row.new_fingerprint }, request);
    const epoch = (db.prepare('SELECT device_epoch FROM users WHERE id=?').get(user.id) as { device_epoch: number }).device_epoch;
    return { accessToken: issueToken(user.id, epoch), user: appUser(user.id) };
  });

  app.post('/api/account/password', { preHandler: authenticate }, async (request, reply) => {
    const { currentPassword, newPassword } = request.body as { currentPassword?: unknown; newPassword?: unknown };
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || newPassword.length < 10 || newPassword.length > 128) return reply.code(400).send({ error: '当前密码和 10-128 位新密码均为必填项' });
    const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(request.user.sub) as { password_hash: string };
    if (!await verifyPassword(currentPassword, row.password_hash)) return reply.code(401).send({ error: '当前密码不正确' });
    db.prepare('UPDATE users SET password_hash=?,password_plain=?,device_epoch=device_epoch+1,updated_at=? WHERE id=?').run(await hashPassword(newPassword), newPassword, Date.now(), request.user.sub);
    for (const peer of sockets.get(request.user.sub) ?? []) peer.close(1008, 'Credentials changed');
    sockets.delete(request.user.sub);
    audit(`user:${request.user.sub}`, 'account.password', `user:${request.user.sub}`, {}, request);
    return { updated: true };
  });

  app.get('/api/vip/overage', { preHandler: authenticate }, async (request) => {
    const vip = isVip(db, request.user.sub);
    const ownedGroups = (db.prepare('SELECT g.id,g.name,COUNT(gm.user_id) memberCount FROM chat_groups g LEFT JOIN group_members gm ON gm.group_id=g.id WHERE g.owner_id=? GROUP BY g.id ORDER BY g.created_at DESC').all(request.user.sub) as Array<{ id: number; name: string; memberCount: number }>);
    const ownedGroupLimit = 10; const memberLimit = 100;
    const over = !vip && (ownedGroups.length > ownedGroupLimit || ownedGroups.some((group) => group.memberCount > memberLimit));
    return { over, vip, ownedGroupLimit, memberLimit, ownedGroups };
  });

  app.delete('/api/groups/:groupId', { preHandler: [authenticate, requireDisclaimer] }, async (request, reply) => {
    const groupId = Number((request.params as { groupId: string }).groupId);
    const group = db.prepare('SELECT owner_id FROM chat_groups WHERE id=?').get(groupId) as { owner_id: number } | undefined;
    if (!group) return reply.code(404).send({ error: '群组不存在' });
    if (group.owner_id !== request.user.sub) return reply.code(403).send({ error: '只有群主可以解散群组' });
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM group_join_requests WHERE group_id=?').run(groupId);
      db.prepare('DELETE FROM message_metadata WHERE group_id=?').run(groupId);
      db.prepare('DELETE FROM chat_groups WHERE id=?').run(groupId);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    audit(`user:${request.user.sub}`, 'group.delete', `group:${groupId}`, {}, request);
    return reply.code(204).send();
  });

  app.get('/api/admin/vip-codes', { preHandler: requireAdmin('vip:issue') }, async () => ({ codes: db.prepare(`SELECT v.id,v.code_hint codeHint,v.duration_seconds durationSeconds,v.created_by createdBy,v.created_at createdAt,v.redeemed_at redeemedAt,v.redeemed_by redeemedBy,u.email redeemedEmail,u.display_name redeemedName FROM vip_codes v LEFT JOIN users u ON u.id=v.redeemed_by ORDER BY v.id DESC LIMIT 100`).all() }));
  app.get('/api/admin/vip-users', { preHandler: requireAdmin('vip:revoke') }, async () => ({ users: db.prepare(`SELECT u.uuid,u.email,u.display_name displayName,v.expires_at vipExpiresAt FROM vip_entitlements v JOIN users u ON u.id=v.user_id WHERE v.expires_at=0 OR v.expires_at>? ORDER BY v.expires_at DESC`).all(Date.now()) }));
  app.get('/api/admin/vip-codes/:id', { preHandler: requireAdmin('vip:issue') }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const code = db.prepare(`SELECT v.id,v.code_hint codeHint,v.duration_seconds durationSeconds,v.created_by createdBy,v.created_at createdAt,v.redeemed_at redeemedAt,v.redeemed_by redeemedBy,u.email redeemedEmail,u.display_name redeemedName FROM vip_codes v LEFT JOIN users u ON u.id=v.redeemed_by WHERE v.id=?`).get(id);
    return code ? { code } : reply.code(404).send({ error: '卡密不存在' });
  });
  app.post('/api/admin/users/:uuid/revoke-vip', { preHandler: requireAdmin('vip:revoke') }, async (request, reply) => {
    const uuid = (request.params as { uuid: string }).uuid; const id = adminUserId(uuid); const admin = (request as FastifyRequest & { admin: AdminIdentity }).admin;
    if (id === undefined) return reply.code(404).send({ error: '用户不存在' });
    if (!admin.root && isPlatformAdmin(db, id)) return reply.code(403).send({ error: '只有 Root 可以对平台管理员操作' });
    const now = Date.now(); const result = db.prepare('UPDATE vip_entitlements SET expires_at=?,updated_at=? WHERE user_id=? AND (expires_at=0 OR expires_at>?)').run(now, now, id, now);
    audit(admin.actor, 'vip.revoke', `user:${uuid}`, { revokedAt: now }, request);
    return { revoked: Boolean(result.changes), wasActive: Boolean(result.changes) };
  });
  app.post('/api/admin/users/:uuid/reset-password', { preHandler: requireAdmin('users:delete', true) }, async (request, reply) => {
    const uuid = (request.params as { uuid: string }).uuid; const id = adminUserId(uuid); const admin = (request as FastifyRequest & { admin: AdminIdentity }).admin;
    if (id === undefined) return reply.code(404).send({ error: '用户不存在' });
    const temporaryPassword = `Lm!${randomToken(16)}`;
    db.prepare('UPDATE users SET password_hash=?,password_plain=?,device_epoch=device_epoch+1,updated_at=? WHERE id=?').run(await hashPassword(temporaryPassword), temporaryPassword, Date.now(), id);
    for (const peer of sockets.get(id) ?? []) peer.close(1008, 'Credentials reset');
    sockets.delete(id);
    audit(admin.actor, 'user.reset-password', `user:${uuid}`, { generatedTemporaryPassword: true }, request);
    return { updated: true, temporaryPassword, oneTimeDisplay: true };
  });
  app.post('/api/admin/users/:uuid/delete', { preHandler: requireAdmin('users:delete') }, async (request, reply) => {
    const uuid = (request.params as { uuid: string }).uuid; const id = adminUserId(uuid); const admin = (request as FastifyRequest & { admin: AdminIdentity }).admin;
    if (id === undefined) return reply.code(404).send({ error: '用户不存在' });
    if (!admin.root && isPlatformAdmin(db, id)) return reply.code(403).send({ error: '只有 Root 可以对平台管理员操作' });
    for (const peer of sockets.get(id) ?? []) peer.close(1008, 'Account removed'); sockets.delete(id);
    db.prepare('DELETE FROM users WHERE id=?').run(id);
    audit(admin.actor, 'user.remote-delete', `user:${uuid}`, {}, request);
    return { deleted: true };
  });
  app.get('/api/admin/audit', { preHandler: requireAdmin('audit:read') }, async () => ({ entries: db.prepare(`SELECT a.id,a.actor,a.action,a.target,a.metadata,a.ip,a.created_at createdAt,
    actorUser.display_name actorName,actorUser.uuid actorUuid,actorKey.name actorKeyName,
    CASE WHEN a.actor='root' THEN '蓝喵喵' WHEN actorKey.name IS NOT NULL THEN actorKey.name WHEN actorUser.display_name IS NOT NULL THEN actorUser.display_name ELSE a.actor END actorLabel,
    targetUser.uuid targetUuid,targetUser.display_name targetName
    FROM audit_log a LEFT JOIN users actorUser ON a.actor='user:'||actorUser.id OR a.actor='platform-admin:'||actorUser.id
    LEFT JOIN admin_keys actorKey ON a.actor='key:'||actorKey.id
    LEFT JOIN users targetUser ON a.target='user:'||targetUser.id OR a.target='user:'||targetUser.uuid ORDER BY a.id DESC LIMIT 500`).all() }));
  app.delete('/api/admin/audit/:id', { preHandler: requireAdmin('audit:read') }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: 'Invalid audit entry id' });
    const result = db.prepare('DELETE FROM audit_log WHERE id=?').run(id);
    if (!result.changes) return reply.code(404).send({ error: 'Audit entry not found' });
    return { deleted: true };
  });
  app.delete('/api/admin/audit', { preHandler: requireAdmin('audit:read') }, async () => {
    const result = db.prepare('DELETE FROM audit_log').run();
    return { deleted: Number(result.changes) };
  });

  app.addHook('onClose', async () => { clearInterval(queueCleanup); db.close(); });
  return app;
}
