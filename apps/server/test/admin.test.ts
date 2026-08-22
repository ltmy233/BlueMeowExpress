import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';

let app: FastifyInstance;
let db: DatabaseSync;
const rootKey = 'root-key-with-sufficient-random-looking-content';

beforeEach(async () => {
  db = openDatabase(':memory:');
  app = await buildApp({
    host: '127.0.0.1', port: 3210, databasePath: ':memory:',
    jwtSecret: 'test-secret-that-is-at-least-32-characters', rootKeyHash: sha256(rootKey),
    offlineTtlSeconds: 60, emailCodeTtlSeconds: 600,
  }, db);
});

describe('UUID administration and overview', () => {
  it('searches and bans by UUID while reporting safe aggregate statistics', async () => {
    const now = Date.now(); const uuid = randomUUID();
    const id = Number(db.prepare('INSERT INTO users(uuid,email,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(uuid, 'uuid@example.com', 'hash', 'UUID User', now, now).lastInsertRowid);
    db.prepare('INSERT INTO qq_bindings(user_id,qq_number,group_id,bound_at,last_seen_at) VALUES (?,?,?,?,?)').run(id, '3638856918', '1084255058', now, now);
    db.prepare('INSERT INTO users(uuid,email,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), 'unfinished@example.com', 'hash', 'Unfinished User', now, now);
    db.prepare('INSERT INTO vip_entitlements(user_id,expires_at,updated_at) VALUES (?,?,?)').run(id, now + 60_000, now);
    db.prepare('INSERT INTO chat_groups(owner_id,name,created_at) VALUES (?,?,?)').run(id, 'UUID Group', now);

    const found = await app.inject({ method: 'GET', url: `/api/admin/users?q=${uuid}`, headers: { 'x-admin-key': rootKey } });
    assert.equal(found.statusCode, 200); assert.equal(found.json().users.length, 1); assert.equal(found.json().users[0].uuid, uuid); assert.equal(found.json().users[0].id, undefined);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/users', headers: { 'x-admin-key': rootKey } })).json().users.length, 1);
    assert.equal((await app.inject({ method: 'GET', url: `/api/admin/users/${uuid}`, headers: { 'x-admin-key': rootKey } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/users/${uuid}/ban`, headers: { 'x-admin-key': rootKey }, payload: { banned: true, reason: 'test', durationSeconds: 86400 } })).statusCode, 200);
    const ban = db.prepare('SELECT banned_at bannedAt,banned_until bannedUntil FROM users WHERE id=?').get(id) as { bannedAt: number; bannedUntil: number };
    assert.ok(ban.bannedUntil - ban.bannedAt >= 86_399_000 && ban.bannedUntil - ban.bannedAt <= 86_401_000);

    const overview = await app.inject({ method: 'GET', url: '/api/admin/overview', headers: { 'x-admin-key': rootKey } });
    assert.equal(overview.statusCode, 200);
    assert.deepEqual({ registeredUsers: overview.json().registeredUsers, onlineUsers: overview.json().onlineUsers, activeVip: overview.json().activeVip, bannedUsers: overview.json().bannedUsers, groups: overview.json().groups, activePlatformAdmins: overview.json().activePlatformAdmins }, { registeredUsers: 1, onlineUsers: 0, activeVip: 1, bannedUsers: 1, groups: 1, activePlatformAdmins: 0 });
    assert.equal(overview.json().status, 'ok'); assert.ok(overview.json().startedAt); assert.equal(overview.json().pid, undefined);
  });

  it('counts unique online users rather than open sockets', async () => {
    const now = Date.now(); const uuid = randomUUID();
    const id = Number(db.prepare('INSERT INTO users(uuid,email,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(uuid, 'online@example.com', 'hash', 'Online User', now, now).lastInsertRowid);
    const disclaimer = (await app.inject({ method: 'GET', url: '/api/disclaimer' })).json();
    db.prepare('INSERT INTO disclaimer_acceptances(user_id,version,accepted_at) VALUES (?,?,?)').run(id, disclaimer.version, now);
    const address = await app.listen({ host: '127.0.0.1', port: 0 }); const token = app.jwt.sign({ sub: id });
    const sockets = [new WebSocket(`${address.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`), new WebSocket(`${address.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`)];
    await Promise.all(sockets.map(socket => new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); })));
    const overview = await app.inject({ method: 'GET', url: '/api/admin/overview', headers: { 'x-admin-key': rootKey } });
    assert.equal(overview.json().onlineUsers, 1);
    sockets.forEach(socket => socket.close());
  });
});
afterEach(async () => app.close());

describe('admin key permissions', () => {
  it('allows an audit-authorized key or root to delete audit entries', async () => {
    const subordinate = (await app.inject({ method: 'POST', url: '/api/admin/keys', headers: { 'x-admin-key': rootKey }, payload: { name: 'audit viewer', scopes: ['audit:read'] } })).json().key as string;
    await app.inject({ method: 'POST', url: '/api/admin/announcements', headers: { 'x-admin-key': rootKey }, payload: { title: 'Audit test', body: 'Audit test body' } });
    const before = await app.inject({ method: 'GET', url: '/api/admin/audit', headers: { 'x-admin-key': rootKey } });
    assert.equal(before.statusCode, 200);
    assert.equal(before.json().entries[0].actorLabel, '蓝喵喵');
    const entryId = before.json().entries[0].id as number;
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/audit/${entryId}`, headers: { 'x-admin-key': subordinate } })).statusCode, 200);
    await app.inject({ method: 'POST', url: '/api/admin/announcements', headers: { 'x-admin-key': rootKey }, payload: { title: 'Second audit', body: 'Second audit body' } });
    const rootEntry = (await app.inject({ method: 'GET', url: '/api/admin/audit', headers: { 'x-admin-key': rootKey } })).json().entries[0].id as number;
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/audit/${rootEntry}`, headers: { 'x-admin-key': rootKey } })).statusCode, 200);
    await app.inject({ method: 'POST', url: '/api/admin/announcements', headers: { 'x-admin-key': rootKey }, payload: { title: 'Clear audit', body: 'Clear audit body' } });
    const delegatedClear = await app.inject({ method: 'DELETE', url: '/api/admin/audit', headers: { 'x-admin-key': subordinate } });
    assert.equal(delegatedClear.statusCode, 200);
    assert.equal(delegatedClear.json().deleted > 0, true);
    await app.inject({ method: 'POST', url: '/api/admin/announcements', headers: { 'x-admin-key': rootKey }, payload: { title: 'Root clear', body: 'Root clear body' } });
    const cleared = await app.inject({ method: 'DELETE', url: '/api/admin/audit', headers: { 'x-admin-key': rootKey } });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().deleted > 0, true);
  });

  it('labels audit actors with the user or delegated key name', async () => {
    const delegated = await app.inject({ method: 'POST', url: '/api/admin/keys', headers: { 'x-admin-key': rootKey }, payload: { name: '客服一号', scopes: ['audit:read'] } });
    const keyId = Number((db.prepare('SELECT id FROM admin_keys WHERE name=?').get('客服一号') as { id: number }).id);
    const now = Date.now(); const userId = Number(db.prepare('INSERT INTO users(uuid,email,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), 'audit-name@example.com', 'hash', '小蓝', now, now).lastInsertRowid);
    db.prepare('INSERT INTO audit_log(actor,action,target,metadata,created_at) VALUES (?,?,?,?,?)').run(`key:${keyId}`, 'test.key', null, '{}', now);
    db.prepare('INSERT INTO audit_log(actor,action,target,metadata,created_at) VALUES (?,?,?,?,?)').run(`user:${userId}`, 'test.user', null, '{}', now + 1);
    const audit = await app.inject({ method: 'GET', url: '/api/admin/audit', headers: { 'x-admin-key': delegated.json().key } });
    assert.equal(audit.statusCode, 200);
    assert.equal(audit.json().entries.find((entry: { action: string }) => entry.action === 'test.key').actorLabel, '客服一号');
    assert.equal(audit.json().entries.find((entry: { action: string }) => entry.action === 'test.user').actorLabel, '小蓝');
  });

  it('lets only root create and revoke subordinate keys', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/admin/keys', headers: { 'x-admin-key': rootKey }, payload: { name: 'viewer', scopes: ['users:read'] } });
    assert.equal(created.statusCode, 201);
    const subordinate = created.json().key as string;
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/users', headers: { 'x-admin-key': subordinate } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/keys', headers: { 'x-admin-key': subordinate }, payload: { name: 'forbidden', scopes: ['users:read'] } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/keys/1/revoke', headers: { 'x-admin-key': subordinate }, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/keys/1/revoke', headers: { 'x-admin-key': rootKey }, payload: {} })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/users', headers: { 'x-admin-key': subordinate } })).statusCode, 403);
  });

  it('does not grant unscoped ban access', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/admin/keys', headers: { 'x-admin-key': rootKey }, payload: { name: 'viewer', scopes: ['users:read'] } });
    const response = await app.inject({ method: 'POST', url: '/api/admin/users/1/ban', headers: { 'x-admin-key': created.json().key }, payload: { banned: true } });
    assert.equal(response.statusCode, 403);
  });

  it('grants remote deletion only to root or a key with users:delete', async () => {
    const now = Date.now();
    const createTarget = (email: string) => {
      const uuid = randomUUID();
      db.prepare('INSERT INTO users(uuid,email,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(uuid, email, 'hash', 'Delete Target', now, now);
      return uuid;
    };
    const viewer = (await app.inject({ method: 'POST', url: '/api/admin/keys', headers: { 'x-admin-key': rootKey }, payload: { name: 'viewer', scopes: ['users:read'] } })).json().key as string;
    const deleter = (await app.inject({ method: 'POST', url: '/api/admin/keys', headers: { 'x-admin-key': rootKey }, payload: { name: 'deleter', scopes: ['users:delete'] } })).json().key as string;
    const blocked = createTarget('delete-blocked@example.com');
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/users/${blocked}/delete`, headers: { 'x-admin-key': viewer }, payload: {} })).statusCode, 403);
    const delegated = createTarget('delete-delegated@example.com');
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/users/${delegated}/delete`, headers: { 'x-admin-key': deleter }, payload: {} })).statusCode, 200);
    const rooted = createTarget('delete-root@example.com');
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/users/${rooted}/delete`, headers: { 'x-admin-key': rootKey }, payload: {} })).statusCode, 200);
  });

  it('never lets a fully scoped subordinate key manage panel keys, MOD codes, roles, or root bans', async () => {
    const scopes = ['users:read', 'vip:issue', 'platform-admins:read', 'announcements:write', 'audit:read', 'keys:read'];
    const subordinate = (await app.inject({ method: 'POST', url: '/api/admin/keys', headers: { 'x-admin-key': rootKey }, payload: { name: 'all ordinary scopes', scopes } })).json().key as string;
    const now = Date.now(); const uuid = randomUUID();
    db.prepare('INSERT INTO users(uuid,email,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(uuid, 'boundary@example.com', 'hash', 'Boundary', now, now);
    const headers = { 'x-admin-key': subordinate };
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/keys', headers, payload: { name: 'child', scopes: ['users:read'] } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/keys', headers })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/keys/1/revoke', headers, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/platform-admin-codes', headers, payload: { count: 1 } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/platform-admin-codes', headers })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/platform-admin-codes/1/revoke', headers, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/platform-admins/${uuid}/revoke`, headers, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/users/${uuid}/ban`, headers, payload: { banned: true } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/vip-codes', headers, payload: { duration: 'hour', count: 1 } })).statusCode, 200);
  });

  it('reports platform administrator code revoke states deterministically', async () => {
    const headers = { 'x-admin-key': rootKey };
    const active = (await app.inject({ method: 'POST', url: '/api/admin/platform-admin-codes', headers, payload: { count: 1 } })).json().codes[0] as string;
    const activeId = Number((db.prepare('SELECT id FROM platform_admin_codes WHERE code_hash=?').get(sha256(active)) as { id: number }).id);
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/platform-admin-codes/${activeId}/revoke`, headers, payload: {} })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/platform-admin-codes/${activeId}/revoke`, headers, payload: {} })).json().status, 'revoked');

    const redeemed = (await app.inject({ method: 'POST', url: '/api/admin/platform-admin-codes', headers, payload: { count: 1 } })).json().codes[0] as string;
    const redeemedId = Number((db.prepare('SELECT id FROM platform_admin_codes WHERE code_hash=?').get(sha256(redeemed)) as { id: number }).id);
    const redeemedBy = Number(db.prepare('INSERT INTO users(uuid,email,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), 'redeemed-code@example.com', 'hash', 'Redeemed', Date.now(), Date.now()).lastInsertRowid);
    db.prepare('UPDATE platform_admin_codes SET redeemed_at=?,redeemed_by=? WHERE id=?').run(Date.now(), redeemedBy, redeemedId);
    const redeemedResponse = await app.inject({ method: 'POST', url: `/api/admin/platform-admin-codes/${redeemedId}/revoke`, headers, payload: {} });
    assert.equal(redeemedResponse.statusCode, 409); assert.equal(redeemedResponse.json().status, 'redeemed');

    const expired = (await app.inject({ method: 'POST', url: '/api/admin/platform-admin-codes', headers, payload: { count: 1, expiresAt: Date.now() + 60_000 } })).json().codes[0] as string;
    const expiredId = Number((db.prepare('SELECT id FROM platform_admin_codes WHERE code_hash=?').get(sha256(expired)) as { id: number }).id);
    db.prepare('UPDATE platform_admin_codes SET expires_at=? WHERE id=?').run(Date.now() - 1, expiredId);
    const expiredResponse = await app.inject({ method: 'POST', url: `/api/admin/platform-admin-codes/${expiredId}/revoke`, headers, payload: {} });
    assert.equal(expiredResponse.statusCode, 200); assert.equal(expiredResponse.json().status, 'revoked');
    assert.ok((db.prepare('SELECT revoked_at FROM platform_admin_codes WHERE id=?').get(expiredId) as { revoked_at: number | null }).revoked_at);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/platform-admin-codes/nope/revoke', headers, payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/platform-admin-codes/999999/revoke', headers, payload: {} })).statusCode, 404);
  });

  it('validates predefined and custom VIP issuance requests', async () => {
    const headers = { 'x-admin-key': rootKey };
    for (const duration of ['hour', 'day', 'week', 'month', 'quarter', 'year']) {
      const response = await app.inject({ method: 'POST', url: '/api/admin/vip-codes', headers, payload: { duration, count: 1 } });
      assert.equal(response.statusCode, 200, duration); assert.equal(response.json().oneTime, true);
    }
    const hours = await app.inject({ method: 'POST', url: '/api/admin/vip-codes', headers, payload: { duration: 'custom', durationHours: 2, count: 1 } });
    assert.equal(hours.statusCode, 200); assert.equal(hours.json().durationSeconds, 7_200);
    const seconds = await app.inject({ method: 'POST', url: '/api/admin/vip-codes', headers, payload: { duration: 'custom', durationSeconds: 86_400, count: 1 } });
    assert.equal(seconds.statusCode, 200); assert.equal(seconds.json().durationSeconds, 86_400);
    for (const payload of [
      { duration: 'custom', count: 1 },
      { duration: 'custom', durationHours: 1, durationSeconds: 3_600, count: 1 },
      { duration: 'custom', durationHours: 0, count: 1 },
      { duration: 'custom', durationSeconds: 3_153_600_001, count: 1 },
      { duration: 'day', durationHours: 1, count: 1 },
      { duration: 'unknown', count: 1 },
    ]) assert.equal((await app.inject({ method: 'POST', url: '/api/admin/vip-codes', headers, payload })).statusCode, 400);
  });

  it('keeps VIP, MOD, and ADM credentials strictly non-interchangeable', async () => {
    const now = Date.now(); const uuid = randomUUID();
    const id = Number(db.prepare('INSERT INTO users(uuid,email,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(uuid, 'separate@example.com', 'hash', 'Separate', now, now).lastInsertRowid);
    const vip = (await app.inject({ method: 'POST', url: '/api/admin/vip-codes', headers: { 'x-admin-key': rootKey }, payload: { duration: 'hour', count: 1 } })).json().codes[0] as string;
    const mod = (await app.inject({ method: 'POST', url: '/api/admin/platform-admin-codes', headers: { 'x-admin-key': rootKey }, payload: { count: 1 } })).json().codes[0] as string;
    const adm = (await app.inject({ method: 'POST', url: '/api/admin/keys', headers: { 'x-admin-key': rootKey }, payload: { name: 'vip issuer', scopes: ['vip:issue'] } })).json().key as string;
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/session', headers: { 'x-admin-key': vip } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/session', headers: { 'x-admin-key': mod } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/vip/redeem', headers: { authorization: `Bearer ${app.jwt.sign({ sub: id })}` }, payload: { code: adm } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/platform-admin/redeem', headers: { authorization: `Bearer ${app.jwt.sign({ sub: id })}` }, payload: { code: vip } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/vip/redeem', headers: { authorization: `Bearer ${app.jwt.sign({ sub: id })}` }, payload: { code: vip } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/platform-admin/redeem', headers: { authorization: `Bearer ${app.jwt.sign({ sub: id })}` }, payload: { code: mod } })).statusCode, 200);
  });
});
