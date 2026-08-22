import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';

let app: FastifyInstance;
let db: DatabaseSync;
const rootKey = 'root-key-with-sufficient-random-looking-content';
const pluginToken = 'qq-plugin-token-with-sufficient-random-content';
const pluginHeaders = { 'x-lanmiao-plugin-token': pluginToken };

function createUser(email: string, name: string): number {
  const now = Date.now();
  return Number(db.prepare('INSERT INTO users(uuid,email,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), email, 'hash', name, now, now).lastInsertRowid);
}

function bearer(userId: number): { authorization: string } {
  return { authorization: `Bearer ${app.jwt.sign({ sub: userId, deviceEpoch: 0 })}` };
}

beforeEach(async () => {
  db = openDatabase(':memory:');
  app = await buildApp({
    host: '127.0.0.1', port: 3210, databasePath: ':memory:',
    jwtSecret: 'test-secret-that-is-at-least-32-characters', rootKeyHash: sha256(rootKey),
    offlineTtlSeconds: 60, emailCodeTtlSeconds: 600,
    qqBotPluginToken: pluginToken, qqBindingTtlSeconds: 300,
  }, db);
});

describe('QQ verification plugin boundary', () => {
  it('rejects requests without the independent plugin token', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/qq/bot/heartbeat', payload: {} });
    assert.equal(response.statusCode, 401);
  });

  it('binds only when token and QQ number match', async () => {
    const userId = createUser('qq@example.com', 'QQ User');
    const created = await app.inject({ method: 'POST', url: '/api/qq/binding-request', headers: bearer(userId), payload: { qqNumber: '3638856918' } });
    assert.equal(created.statusCode, 201);
    const token = created.json().token as string;
    assert.match(token, /^\d{7}$/);
    assert.equal(db.prepare('SELECT token_hash FROM qq_binding_requests').get() !== undefined, true);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM qq_binding_requests').get()).includes(token), false);

    const mismatch = await app.inject({ method: 'POST', url: '/api/qq/bind', headers: pluginHeaders, payload: { token, qqNumber: '100001', groupId: '778899' } });
    assert.equal(mismatch.statusCode, 400);
    const bound = await app.inject({ method: 'POST', url: '/api/qq/bind', headers: pluginHeaders, payload: { token, qqNumber: '3638856918', groupId: '778899' } });
    assert.equal(bound.statusCode, 200);
    assert.equal(bound.json().bound, true);

    const status = await app.inject({ method: 'GET', url: '/api/qq/binding', headers: bearer(userId) });
    assert.equal(status.json().qqNumber, '3638856918');
    assert.equal(status.json().request, null);
  });

  it('binds the command sender when a request was generated without a QQ number', async () => {
    const userId = createUser('automatic-qq@example.com', 'Automatic QQ');
    const created = await app.inject({ method: 'POST', url: '/api/qq/binding-request', headers: bearer(userId), payload: {} });
    assert.equal(created.statusCode, 201);
    const bound = await app.inject({ method: 'POST', url: '/api/qq/bind', headers: pluginHeaders, payload: { token: created.json().token, qqNumber: '3638856918', groupId: '1084255058' } });
    assert.equal(bound.statusCode, 200); assert.equal(bound.json().qqNumber, '3638856918');
  });

  it('removes expired requests and prevents one QQ from binding twice', async () => {
    const first = createUser('first-qq@example.com', 'First QQ');
    const second = createUser('second-qq@example.com', 'Second QQ');
    const expiredToken = 'LMQ-expired_token_value_12345';
    db.prepare('INSERT INTO qq_binding_requests(user_id,qq_number,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)')
      .run(first, '12345678', sha256(expiredToken), Date.now() - 1, Date.now() - 1_000);
    const expired = await app.inject({ method: 'POST', url: '/api/qq/bind', headers: pluginHeaders, payload: { token: expiredToken, qqNumber: '12345678', groupId: '778899' } });
    assert.equal(expired.statusCode, 400);
    assert.equal((db.prepare('SELECT COUNT(*) count FROM qq_binding_requests').get() as { count: number }).count, 0);

    const createAndRead = async (userId: number) => {
      const response = await app.inject({ method: 'POST', url: '/api/qq/binding-request', headers: bearer(userId), payload: { qqNumber: '22334455' } });
      return response.json().token as string;
    };
    const firstToken = await createAndRead(first);
    assert.equal((await app.inject({ method: 'POST', url: '/api/qq/bind', headers: pluginHeaders, payload: { token: firstToken, qqNumber: '22334455', groupId: '778899' } })).statusCode, 200);
    const secondToken = await createAndRead(second);
    assert.equal((await app.inject({ method: 'POST', url: '/api/qq/bind', headers: pluginHeaders, payload: { token: secondToken, qqNumber: '22334455', groupId: '778899' } })).statusCode, 400);
  });

  it('reports heartbeat, bound count, and QQ fields to the panel', async () => {
    const userId = createUser('panel-qq@example.com', 'Panel QQ');
    const now = Date.now();
    db.prepare('INSERT INTO qq_bindings(user_id,qq_number,group_id,bound_at,last_seen_at) VALUES (?,?,?,?,?)')
      .run(userId, '55667788', '778899', now, now);
    const heartbeat = await app.inject({ method: 'POST', url: '/api/qq/bot/heartbeat', headers: pluginHeaders, payload: { botId: 'astrbot-main', botName: '蓝喵 QQ 验证', groupCount: 2 } });
    assert.equal(heartbeat.statusCode, 200);

    const overview = await app.inject({ method: 'GET', url: '/api/admin/overview', headers: { 'x-admin-key': rootKey } });
    assert.equal(overview.json().qqBot.online, true);
    assert.equal(overview.json().qqBot.groupCount, 2);
    assert.equal(overview.json().boundQqUsers, 1);
    const users = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { 'x-admin-key': rootKey } });
    assert.equal(users.json().users[0].qqNumber, '55667788');
  });

  it('authorizes QQ commands from heartbeat policy and grants VIP to an exact target', async () => {
    const targetId = createUser('vip-qq@example.com', 'Same Name');
    createUser('vip-qq-duplicate@example.com', 'Same Name');
    const target = db.prepare('SELECT uuid FROM users WHERE id=?').get(targetId) as { uuid: string };
    await app.inject({ method: 'POST', url: '/api/qq/bot/heartbeat', headers: pluginHeaders, payload: {
      botId: 'astrbot-main', metadata: { adminQqIds: ['11223344'], groupListEnabled: true, groupListMode: 'whitelist', whitelistGroups: ['778899'] },
    } });
    const forbidden = await app.inject({ method: 'POST', url: '/api/qq/admin/ban', headers: pluginHeaders, payload: { adminQq: '99887766', groupId: '778899', query: target.uuid } });
    assert.equal(forbidden.statusCode, 403);
    const ambiguous = await app.inject({ method: 'POST', url: '/api/qq/admin/ban', headers: pluginHeaders, payload: { adminQq: '11223344', groupId: '778899', query: 'Same Name' } });
    assert.equal(ambiguous.statusCode, 404);
    const granted = await app.inject({ method: 'POST', url: '/api/qq/admin/issue-vip', headers: pluginHeaders, payload: { adminQq: '11223344', groupId: '778899', query: target.uuid, durationSeconds: 3600 } });
    assert.equal(granted.statusCode, 200);
    const entitlement = db.prepare('SELECT expires_at expiresAt FROM vip_entitlements WHERE user_id=?').get(targetId) as { expiresAt: number };
    assert.ok(entitlement.expiresAt > Date.now());
  });
});

afterEach(async () => app.close());
