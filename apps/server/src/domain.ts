// 业务规则：VIP 时长与兑换码、群组创建与成员限制、平台管理员晋升码
import type { Database } from './db.js';
import { randomToken, sha256 } from './security.js';

export const VIP_DURATIONS = {
  hour: 3_600,
  day: 86_400,
  week: 604_800,
  month: 2_592_000,
  quarter: 7_776_000,
  year: 31_536_000,
  permanent: -1,
} as const;
export type VipDuration = keyof typeof VIP_DURATIONS;
export const MIN_VIP_DURATION_SECONDS = 1;
export const MAX_VIP_DURATION_SECONDS = 3_153_600_000;

export class DomainError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

function transaction<T>(db: Database, callback: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function isVip(db: Database, userId: number, now = Date.now()): boolean {
  const row = db.prepare('SELECT expires_at FROM vip_entitlements WHERE user_id = ?').get(userId) as { expires_at: number } | undefined;
  return Boolean(row && (row.expires_at === 0 || row.expires_at > now));
}

export function createGroup(db: Database, ownerId: number, name: string, now = Date.now(), bypassLimits = false): number {
  return transaction(db, () => {
    const vip = isVip(db, ownerId, now);
    const count = (db.prepare('SELECT COUNT(*) count FROM chat_groups WHERE owner_id = ?').get(ownerId) as { count: number }).count;
    if (!bypassLimits && !vip && count >= 10) throw new DomainError(409, 'Ordinary users may own at most 10 groups');
    const result = db.prepare('INSERT INTO chat_groups(owner_id, name, created_at) VALUES (?, ?, ?)').run(ownerId, name, now);
    const groupId = Number(result.lastInsertRowid);
    db.prepare("INSERT INTO group_members(group_id, user_id, joined_at, role) VALUES (?, ?, ?, 'owner')").run(groupId, ownerId, now);
    return groupId;
  });
}

export function addGroupMember(db: Database, groupId: number, actorId: number, userId: number, now = Date.now(), bypassLimits = false): void {
  transaction(db, () => {
    const group = db.prepare('SELECT owner_id FROM chat_groups WHERE id = ?').get(groupId) as { owner_id: number } | undefined;
    if (!group) throw new DomainError(404, 'Group not found');
    if (group.owner_id !== actorId) throw new DomainError(403, 'Only the group owner may add members');
    const limit = isVip(db, group.owner_id, now) ? 300 : 100;
    const count = (db.prepare('SELECT COUNT(*) count FROM group_members WHERE group_id = ?').get(groupId) as { count: number }).count;
    if (!bypassLimits && count >= limit) throw new DomainError(409, `Group member limit is ${limit}`);
    try {
      db.prepare('INSERT INTO group_members(group_id, user_id, joined_at) VALUES (?, ?, ?)').run(groupId, userId, now);
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new DomainError(409, 'User is already a member');
      throw error;
    }
  });
}

export function forceJoinGroup(db: Database, groupId: number, adminId: number, now = Date.now()): void {
  transaction(db, () => {
    if (!isPlatformAdmin(db, adminId)) throw new DomainError(403, 'Active platform administrator required');
    if (!db.prepare('SELECT 1 FROM chat_groups WHERE id=?').get(groupId)) throw new DomainError(404, 'Group not found');
    db.prepare("INSERT OR IGNORE INTO group_members(group_id,user_id,joined_at,role,forced_by) VALUES (?,?,?,'member',?)")
      .run(groupId, adminId, now, adminId);
  });
}

export function vipDurationSeconds(duration: VipDuration | number): number {
  const seconds = typeof duration === 'number' ? duration : VIP_DURATIONS[duration];
  if (duration === 'permanent') return -1;
  if (!Number.isInteger(seconds) || seconds < MIN_VIP_DURATION_SECONDS || seconds > MAX_VIP_DURATION_SECONDS) {
    throw new DomainError(400, 'VIP 时长必须在 1 秒到永久（100 年）之间');
  }
  return seconds;
}

export function generateVipCodes(db: Database, duration: VipDuration | number, count: number, actor: string, now = Date.now()): string[] {
  const durationSeconds = vipDurationSeconds(duration);
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new DomainError(400, 'Count must be between 1 and 100');
  return transaction(db, () => Array.from({ length: count }, () => {
    const code = `LTSD-VIP-${randomToken(18)}`;
    db.prepare('INSERT INTO vip_codes(code_hash, code_hint, duration_seconds, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(code), code.slice(-6), durationSeconds, actor, now);
    return code;
  }));
}

export function redeemVipCode(db: Database, userId: number, code: string, now = Date.now()): number {
  const normalized = code.match(/(?:LTSD|LTMY)-VIP-[A-Za-z0-9_-]{24}/)?.[0];
  if (!normalized) throw new DomainError(400, '卡密格式不正确，请使用 LTSD-VIP 开头的兑换码');
  return transaction(db, () => {
    const row = db.prepare('SELECT id, duration_seconds, redeemed_at FROM vip_codes WHERE code_hash = ?').get(sha256(normalized)) as
      | { id: number; duration_seconds: number; redeemed_at: number | null }
      | undefined;
    if (!row) throw new DomainError(404, '卡密不存在或已失效');
    if (row.redeemed_at !== null) throw new DomainError(409, '该卡密已被使用，不能再次兑换');
    const current = db.prepare('SELECT expires_at FROM vip_entitlements WHERE user_id = ?').get(userId) as { expires_at: number } | undefined;
    const expiresAt = row.duration_seconds === -1 || current?.expires_at === 0
      ? 0
      : Math.max(now, current?.expires_at ?? 0) + row.duration_seconds * 1000;
    const redeemed = db.prepare('UPDATE vip_codes SET redeemed_by = ?, redeemed_at = ? WHERE id = ? AND redeemed_at IS NULL').run(userId, now, row.id);
    if (!redeemed.changes) throw new DomainError(409, '该卡密已被使用，不能再次兑换');
    db.prepare(`INSERT INTO vip_entitlements(user_id, expires_at, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET expires_at = excluded.expires_at, updated_at = excluded.updated_at`)
      .run(userId, expiresAt, now);
    return expiresAt;
  });
}

export function generatePlatformAdminCodes(db: Database, count: number, expiresAt: number | null, now = Date.now()): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new DomainError(400, 'Count must be between 1 and 100');
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now)) throw new DomainError(400, 'Expiry must be in the future');
  return transaction(db, () => Array.from({ length: count }, () => {
    const code = `LTSD-MOD-${randomToken(18)}`;
    db.prepare('INSERT INTO platform_admin_codes(code_hash,code_hint,created_at,expires_at) VALUES (?,?,?,?)')
      .run(sha256(code), code.slice(-6), now, expiresAt);
    return code;
  }));
}

export function redeemPlatformAdminCode(db: Database, userId: number, code: string, now = Date.now()): void {
  if (!code.startsWith('LTSD-MOD-') && !code.startsWith('LTMY-MOD-')) throw new DomainError(400, '晋升码格式不正确，请使用 LTSD-MOD 开头的兑换码');
  transaction(db, () => {
    const row = db.prepare('SELECT id,expires_at,revoked_at,redeemed_at FROM platform_admin_codes WHERE code_hash=?').get(sha256(code)) as
      | { id: number; expires_at: number | null; revoked_at: number | null; redeemed_at: number | null } | undefined;
    if (!row || row.revoked_at !== null || row.redeemed_at !== null || (row.expires_at !== null && row.expires_at <= now)) {
      throw new DomainError(409, 'Code is invalid, expired, revoked, or already redeemed');
    }
    const changed = db.prepare('UPDATE platform_admin_codes SET redeemed_by=?,redeemed_at=? WHERE id=? AND redeemed_at IS NULL AND revoked_at IS NULL').run(userId, now, row.id);
    if (!changed.changes) throw new DomainError(409, 'Code is already redeemed');
    db.prepare('UPDATE users SET platform_admin_at=?,platform_admin_revoked_at=NULL,updated_at=? WHERE id=?').run(now, now, userId);
  });
}

export function isPlatformAdmin(db: Database, userId: number): boolean {
  const row = db.prepare('SELECT platform_admin_at,platform_admin_revoked_at FROM users WHERE id=?').get(userId) as
    | { platform_admin_at: number | null; platform_admin_revoked_at: number | null } | undefined;
  return Boolean(row?.platform_admin_at !== null && row?.platform_admin_revoked_at === null);
}

export const ADMIN_SCOPES = ['users:read', 'users:ban', 'users:delete', 'vip:issue', 'vip:revoke', 'audit:read', 'keys:read', 'announcements:write', 'platform-admins:read', 'groups:read', 'groups:manage'] as const;
export type AdminScope = typeof ADMIN_SCOPES[number];

export function hasScope(scopes: string, required: AdminScope): boolean {
  return scopes.split(',').includes(required);
}
