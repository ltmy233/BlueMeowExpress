import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { DomainError, VIP_DURATIONS, addGroupMember, createGroup, generatePlatformAdminCodes, generateVipCodes, hasScope, isPlatformAdmin, redeemPlatformAdminCode, redeemVipCode, vipDurationSeconds } from '../src/domain.js';

let db: DatabaseSync;
const now = 1_700_000_000_000;

function user(email: string): number {
  return Number(db.prepare('INSERT INTO users(uuid,email,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), email, 'hash', email, now, now).lastInsertRowid);
}

beforeEach(() => { db = openDatabase(':memory:'); });
afterEach(() => db.close());

describe('group quotas', () => {
  it('limits ordinary owners to ten groups and permits active VIP beyond ten', () => {
    const owner = user('owner@example.com');
    for (let index = 0; index < 10; index++) createGroup(db, owner, `group-${index}`, now);
    assert.throws(() => createGroup(db, owner, 'eleven', now), DomainError);
    db.prepare('INSERT INTO vip_entitlements(user_id,expires_at,updated_at) VALUES (?,?,?)').run(owner, now + 60_000, now);
    assert.equal(createGroup(db, owner, 'eleven', now), 11);
  });

  it('uses 100 and 300 member limits according to owner VIP state', () => {
    const owner = user('owner@example.com');
    const group = createGroup(db, owner, 'ordinary', now);
    for (let index = 1; index < 100; index++) addGroupMember(db, group, owner, user(`u${index}@example.com`), now);
    const extra = user('extra@example.com');
    assert.throws(() => addGroupMember(db, group, owner, extra, now), DomainError);
    db.prepare('INSERT INTO vip_entitlements(user_id,expires_at,updated_at) VALUES (?,?,?)').run(owner, now + 60_000, now);
    addGroupMember(db, group, owner, extra, now);
    assert.equal((db.prepare('SELECT COUNT(*) count FROM group_members WHERE group_id=?').get(group) as { count: number }).count, 101);
  });

  it('allows an active platform administrator owner to bypass group quotas', () => {
    const owner = user('platform-owner@example.com');
    db.prepare('UPDATE users SET platform_admin_at=? WHERE id=?').run(now, owner);
    for (let index = 0; index < 11; index++) createGroup(db, owner, `admin-${index}`, now, true);
    const group = 1;
    for (let index = 0; index < 100; index++) addGroupMember(db, group, owner, user(`admin-member-${index}@example.com`), now, true);
    assert.equal((db.prepare('SELECT COUNT(*) count FROM group_members WHERE group_id=?').get(group) as { count: number }).count, 101);
  });
});

describe('VIP code lifecycle', () => {
  it('stores every predefined duration in seconds', () => {
    for (const [duration, seconds] of Object.entries(VIP_DURATIONS)) {
      generateVipCodes(db, duration as keyof typeof VIP_DURATIONS, 1, 'root', now);
      const stored = db.prepare('SELECT duration_seconds durationSeconds FROM vip_codes ORDER BY id DESC LIMIT 1').get() as { durationSeconds: number };
      assert.equal(stored.durationSeconds, seconds, duration);
    }
  });

  it('accepts bounded custom seconds and rejects invalid custom durations', () => {
    const [code] = generateVipCodes(db, 7_200, 1, 'root', now);
    assert.ok(code?.startsWith('LTSD-VIP-'));
    assert.equal((db.prepare('SELECT duration_seconds FROM vip_codes').get() as { duration_seconds: number }).duration_seconds, 7_200);
    const [oneSecond] = generateVipCodes(db, 1, 1, 'root', now);
    assert.ok(oneSecond?.startsWith('LTSD-VIP-'));
    const [permanent] = generateVipCodes(db, 'permanent', 1, 'root', now);
    assert.equal((db.prepare('SELECT duration_seconds FROM vip_codes ORDER BY id DESC LIMIT 1').get() as { duration_seconds: number }).duration_seconds, VIP_DURATIONS.permanent);
    for (const invalid of [0, 3_153_600_001, 1.5, Number.NaN]) assert.throws(() => vipDurationSeconds(invalid), DomainError);
  });

  it('creates prefixed codes, redeems once, and extends active VIP', () => {
    const first = user('first@example.com');
    const second = user('second@example.com');
    const [code] = generateVipCodes(db, 'day', 1, 'root', now);
    assert.ok(code?.startsWith('LTSD-VIP-'));
    const firstExpiry = redeemVipCode(db, first, code!, now);
    assert.equal(firstExpiry, now + 86_400_000);
    assert.throws(() => redeemVipCode(db, second, code!, now), DomainError);
    const [wrappedCode] = generateVipCodes(db, 'hour', 1, 'root', now);
    assert.equal(redeemVipCode(db, second, `VIP ID: 12\n卡密: ${wrappedCode}\n`, now), now + 3_600_000);
    const [nextCode] = generateVipCodes(db, 'week', 1, 'root', now);
    assert.equal(redeemVipCode(db, first, nextCode!, now), firstExpiry + 604_800_000);
    assert.equal(isPlatformAdmin(db, first), false);
  });
});

describe('platform administrator code lifecycle', () => {
  it('stores only a hash, expires, redeems atomically once, and grants the role', () => {
    const first = user('mod@example.com'); const second = user('other@example.com');
    const [code] = generatePlatformAdminCodes(db, 1, now + 10_000, now);
    assert.ok(code?.startsWith('LTSD-MOD-'));
    const stored = db.prepare('SELECT code_hash,code_hint FROM platform_admin_codes').get() as { code_hash: string; code_hint: string };
    assert.notEqual(stored.code_hash, code); assert.equal(stored.code_hash.length, 64); assert.equal(stored.code_hint, code!.slice(-6));
    redeemPlatformAdminCode(db, first, code!, now + 1);
    assert.equal(isPlatformAdmin(db, first), true);
    assert.throws(() => redeemPlatformAdminCode(db, second, code!, now + 2), DomainError);
    const [expired] = generatePlatformAdminCodes(db, 1, now + 10, now);
    assert.throws(() => redeemPlatformAdminCode(db, second, expired!, now + 11), DomainError);
  });
});

describe('admin permissions', () => {
  it('requires exact comma-delimited scopes', () => {
    assert.equal(hasScope('users:read,vip:issue', 'users:read'), true);
    assert.equal(hasScope('users:read,vip:issue', 'users:ban'), false);
  });
});
