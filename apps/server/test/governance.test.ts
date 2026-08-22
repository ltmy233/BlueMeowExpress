import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';

let app: FastifyInstance;
let db: DatabaseSync;
const rootKey = 'root-key-with-sufficient-random-looking-content';

function user(email: string): number {
  const now = Date.now();
  return Number(db.prepare('INSERT INTO users(uuid,email,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), email, 'hash', email, now, now).lastInsertRowid);
}
function token(id: number): string { return app.jwt.sign({ sub: id }); }
function auth(id: number) { return { authorization: `Bearer ${token(id)}` }; }
async function accept(id: number) {
  const current = await app.inject({ method: 'GET', url: '/api/disclaimer' });
  return app.inject({ method: 'POST', url: '/api/disclaimer/accept', headers: auth(id), payload: { version: current.json().version } });
}

beforeEach(async () => {
  db = openDatabase(':memory:');
  app = await buildApp({ host: '127.0.0.1', port: 3210, databasePath: ':memory:', jwtSecret: 'test-secret-that-is-at-least-32-characters', rootKeyHash: sha256(rootKey), offlineTtlSeconds: 60, emailCodeTtlSeconds: 600 }, db);
});
afterEach(async () => app.close());

describe('governance migration and disclaimer', () => {
  it('applies 002 and blocks communication state changes until current acceptance', async () => {
    assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE version='002_governance.sql'").get());
    const first = user('first@example.com'); const second = user('second@example.com');
    const blocked = await app.inject({ method: 'POST', url: '/api/contacts/requests', headers: auth(first), payload: { userId: second } });
    assert.equal(blocked.statusCode, 428);
    const disclaimer = (await app.inject({ method: 'GET', url: '/api/disclaimer' })).json();
    assert.match(disclaimer.sections.join(' '), /端到端加密/); assert.match(disclaimer.sections.join(' '), /依法享有的权利/);
    assert.equal((await accept(first)).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/contacts/requests', headers: auth(first), payload: { userId: second } })).statusCode, 201);
  });

  it('upgrades an existing 001 database without losing groups or members', () => {
    const path = join(tmpdir(), `lanmiao-governance-${process.pid}-${Date.now()}.db`);
    const legacy = new DatabaseSync(path); const initial = readFileSync(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
    legacy.exec(initial); legacy.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)').run('001_initial.sql', Date.now());
    const created = Date.now(); const owner = Number(legacy.prepare('INSERT INTO users(email,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?)').run('legacy@example.com', 'hash', 'Legacy', created, created).lastInsertRowid);
    const group = Number(legacy.prepare('INSERT INTO chat_groups(owner_id,name,created_at) VALUES (?,?,?)').run(owner, 'Existing group', created).lastInsertRowid);
    legacy.prepare('INSERT INTO group_members(group_id,user_id,joined_at) VALUES (?,?,?)').run(group, owner, created); legacy.close();
    const upgraded = openDatabase(path);
    try {
      assert.equal((upgraded.prepare('SELECT name FROM chat_groups WHERE id=?').get(group) as { name: string }).name, 'Existing group');
      assert.equal((upgraded.prepare('SELECT role,forced_by FROM group_members WHERE group_id=? AND user_id=?').get(group, owner) as { role: string; forced_by: null }).role, 'owner');
      assert.ok(upgraded.prepare("SELECT 1 FROM schema_migrations WHERE version='002_governance.sql'").get());
      const uuid = (upgraded.prepare('SELECT uuid FROM users WHERE id=?').get(owner) as { uuid: string }).uuid;
      assert.match(uuid, /^[0-9a-f-]{36}$/i);
      assert.throws(() => upgraded.prepare('UPDATE users SET uuid=? WHERE id=?').run(randomUUID(), owner), /immutable/);
      assert.throws(() => upgraded.prepare('INSERT INTO users(uuid,email,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(uuid, 'duplicate@example.com', 'hash', 'Duplicate', created, created), /UNIQUE/);
      assert.ok(upgraded.prepare("SELECT 1 FROM schema_migrations WHERE version='003_user_uuid.sql'").get());
    } finally { upgraded.close(); rmSync(path, { force: true }); }
  });
});

describe('attachment uploads', () => {
  it('stores image and video payloads with Chinese file names', async () => {
    const id = user('media@example.com');
    assert.equal((await accept(id)).statusCode, 200);
    for (const media of [
      { name: '照片.png', mime: 'image/png', data: Buffer.from('small png payload') },
      { name: '视频.mp4', mime: 'video/mp4', data: Buffer.from('small mp4 payload') },
    ]) {
      const uploaded = await app.inject({ method: 'POST', url: '/api/attachments', headers: { ...auth(id), 'content-type': media.mime, 'x-attachment-name': encodeURIComponent(media.name) }, payload: media.data });
      assert.equal(uploaded.statusCode, 201, uploaded.body);
      assert.equal(uploaded.json().name, media.name);
      const downloaded = await app.inject({ method: 'GET', url: `/api/attachments/${uploaded.json().id}`, headers: auth(id) });
      assert.equal(downloaded.statusCode, 200, downloaded.body);
      assert.equal(downloaded.headers['content-type'], media.mime);
    }
  });
});

describe('root platform administrator management', () => {
  it('creates hash-only one-time codes, reports admins, and lets only root revoke', async () => {
    const target = user('mod@example.com');
    const generated = await app.inject({ method: 'POST', url: '/api/admin/platform-admin-codes', headers: { 'x-admin-key': rootKey }, payload: { count: 1 } });
    assert.equal(generated.statusCode, 201); const code = generated.json().codes[0] as string;
    assert.equal(db.prepare('SELECT 1 FROM platform_admin_codes WHERE code_hash=?').get(code), undefined);
    assert.equal((await app.inject({ method: 'POST', url: '/api/platform-admin/redeem', headers: auth(target), payload: { code } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/platform-admin/redeem', headers: auth(user('late@example.com')), payload: { code } })).statusCode, 409);
    const admins = await app.inject({ method: 'GET', url: '/api/admin/platform-admins', headers: { 'x-admin-key': rootKey } });
    assert.equal(admins.json().admins[0].online, false);
    const key = (await app.inject({ method: 'POST', url: '/api/admin/keys', headers: { 'x-admin-key': rootKey }, payload: { name: 'reader', scopes: ['platform-admins:read'] } })).json().key;
    const targetUuid = (db.prepare('SELECT uuid FROM users WHERE id=?').get(target) as { uuid: string }).uuid;
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/platform-admins/${targetUuid}/revoke`, headers: { 'x-admin-key': key }, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/platform-admins/${targetUuid}/revoke`, headers: { 'x-admin-key': rootKey }, payload: {} })).statusCode, 200);
  });
});

describe('groups and platform moderation', () => {
  it('requires contact approval, preserves the request message and searches by QQ', async () => {
    const first = user('friend-one@example.com'); const second = user('friend-two@example.com');
    await accept(first); await accept(second);
    db.prepare('INSERT INTO qq_bindings(user_id,qq_number,group_id,bound_at,last_seen_at) VALUES (?,?,?,?,?)').run(second, '22334455', '1084255058', Date.now(), Date.now());
    const search = await app.inject({ method: 'GET', url: '/api/users/search?q=22334455', headers: auth(first) });
    assert.equal(search.json().users[0].id, String(second));
    const requested = await app.inject({ method: 'POST', url: '/api/contacts', headers: auth(first), payload: { userId: second, message: '我是小蓝，请通过' } });
    assert.equal(requested.statusCode, 201);
    assert.equal((await app.inject({ method: 'POST', url: '/api/conversations/direct', headers: auth(first), payload: { contactId: second } })).statusCode, 404);
    const incoming = await app.inject({ method: 'GET', url: '/api/contacts', headers: auth(second) });
    assert.equal(incoming.json().contacts[0].requestMessage, '我是小蓝，请通过');
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/contacts/requests/${first}`, headers: auth(second), payload: { accept: true } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/conversations/direct', headers: auth(first), payload: { contactId: second } })).statusCode, 200);
  });

  it('keeps an accepted friendship intact when a friend applies again', async () => {
    const first = user('again-one@example.com'); const second = user('again-two@example.com');
    await accept(first); await accept(second);
    assert.equal((await app.inject({ method: 'POST', url: '/api/contacts', headers: auth(first), payload: { userId: second, message: '第一次申请' } })).statusCode, 201);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/contacts/requests/${first}`, headers: auth(second), payload: { accept: true } })).statusCode, 200);
    const again = await app.inject({ method: 'POST', url: '/api/contacts', headers: auth(first), payload: { userId: second, message: '重复申请' } });
    assert.equal(again.statusCode, 201);
    const firstView = await app.inject({ method: 'GET', url: '/api/contacts', headers: auth(first) });
    const relation = firstView.json().contacts.find((item: { id: string }) => item.id === String(second));
    assert.equal(relation.status, 'accepted');
    assert.equal((await app.inject({ method: 'POST', url: '/api/conversations/direct', headers: auth(first), payload: { contactId: second } })).statusCode, 200);
    const secondView = await app.inject({ method: 'GET', url: '/api/contacts', headers: auth(second) });
    assert.equal(secondView.json().contacts.find((item: { id: string }) => item.id === String(first)).status, 'accepted');
  });

  it('rejects contact requests in either direction after a block', async () => {
    const first = user('block-one@example.com'); const second = user('block-two@example.com');
    await accept(first); await accept(second);
    db.prepare('INSERT INTO contact_preferences(owner_id,contact_id,pinned,blocked,updated_at) VALUES (?,?,0,1,?)').run(second, first, Date.now());
    const refused = await app.inject({ method: 'POST', url: '/api/contacts', headers: auth(first), payload: { userId: second, message: 'hi' } });
    assert.equal(refused.statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/contacts/requests', headers: auth(first), payload: { userId: second } })).statusCode, 403);
    const otherWay = await app.inject({ method: 'POST', url: '/api/contacts', headers: auth(second), payload: { userId: first, message: 'hi' } });
    assert.equal(otherWay.statusCode, 403);
    db.prepare('DELETE FROM contact_preferences WHERE owner_id=? AND contact_id=?').run(second, first);
    assert.equal((await app.inject({ method: 'POST', url: '/api/contacts', headers: auth(first), payload: { userId: second, message: 'unblocked' } })).statusCode, 201);
  });

  it('auto-reviews join answers and manages roles, titles and levels', async () => {
    const owner = user('auto-owner@example.com'); const member = user('auto-member@example.com');
    await accept(owner); await accept(member);
    const group = Number((await app.inject({ method: 'POST', url: '/api/groups', headers: auth(owner), payload: { name: 'Auto Review', joinMode: 'question', joinQuestion: '口令？' } })).json().id.replace('g-', ''));
    const settings = await app.inject({ method: 'PATCH', url: `/api/groups/${group}/settings`, headers: auth(owner), payload: { joinMode: 'question', joinQuestion: '口令？', autoReview: true, joinAnswer: '蓝喵' } });
    assert.equal(settings.statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/api/groups/${group}/join`, headers: auth(member), payload: { answer: '错误' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: `/api/groups/${group}/join`, headers: auth(member), payload: { answer: ' 蓝喵 ' } })).statusCode, 201);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/groups/${group}/members/${member}/role`, headers: auth(owner), payload: { role: 'moderator' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/groups/${group}/members/${member}/profile`, headers: auth(owner), payload: { title: '活跃之星', level: 18 } })).statusCode, 200);
    const conversations = await app.inject({ method: 'GET', url: '/api/conversations', headers: auth(owner) });
    const governed = conversations.json().conversations.find((item: { id: string }) => item.id === `g-${group}`);
    const nextMember = governed.members.find((item: { id: string }) => item.id === String(member));
    assert.equal(nextMember.groupRole, 'administrator'); assert.equal(nextMember.memberTitle, '活跃之星'); assert.equal(nextMember.memberLevel, 18);
  });

  it('supports question requests, moderator review, and visible forced membership', async () => {
    const owner = user('owner@example.com'); const member = user('member@example.com'); const mod = user('platform@example.com');
    await accept(owner); await accept(member); await accept(mod);
    const group = Number((await app.inject({ method: 'POST', url: '/api/groups', headers: auth(owner), payload: { name: 'Review', joinMode: 'question', joinQuestion: 'Why?' } })).json().id.replace('g-', ''));
    assert.equal((await app.inject({ method: 'POST', url: `/api/groups/${group}/join`, headers: auth(member), payload: {} })).statusCode, 400);
    const requested = await app.inject({ method: 'POST', url: `/api/groups/${group}/join`, headers: auth(member), payload: { answer: 'Project work' } });
    assert.equal(requested.statusCode, 202);
    assert.equal((await app.inject({ method: 'POST', url: `/api/groups/${group}/join-requests/${requested.json().requestId}`, headers: auth(owner), payload: { approve: true } })).statusCode, 200);
    db.prepare('UPDATE users SET platform_admin_at=? WHERE id=?').run(Date.now(), mod);
    assert.equal((await app.inject({ method: 'POST', url: `/api/platform-admin/groups/${group}/force-join`, headers: auth(mod), payload: {} })).statusCode, 201);
    const members = await app.inject({ method: 'GET', url: `/api/groups/${group}/members`, headers: auth(owner) });
    const forced = members.json().members.find((row: { id: number }) => row.id === mod);
    assert.equal(forced.forcedMembership, 1); assert.equal(forced.forcedBy, mod);
  });

  it('uses random public group numbers and requires a visible rejection reason', async () => {
    const owner = user('number-owner@example.com'); const member = user('number-member@example.com');
    await accept(owner); await accept(member);
    db.prepare('UPDATE users SET platform_admin_at=? WHERE id=?').run(Date.now(), owner);
    const created = await app.inject({ method: 'POST', url: '/api/groups', headers: auth(owner), payload: { name: 'Public Number', joinMode: 'approval', memberIds: [] } });
    assert.equal(created.statusCode, 201);
    const conversation = created.json();
    assert.match(conversation.groupNumber, /^\d{6}$/);
    assert.notEqual(conversation.groupNumber, conversation.id.replace('g-', ''));
    const numbers = new Set([conversation.groupNumber]);
    for (let index = 0; index < 20; index++) {
      const next = await app.inject({ method: 'POST', url: '/api/groups', headers: auth(owner), payload: { name: `Public Number ${index}`, joinMode: 'approval', memberIds: [] } });
      assert.equal(next.statusCode, 201);
      assert.match(next.json().groupNumber, /^\d{6}$/);
      numbers.add(next.json().groupNumber);
    }
    assert.equal(numbers.size, 21);
    const lookup = await app.inject({ method: 'GET', url: `/api/groups/${conversation.groupNumber}/join-info`, headers: auth(member) });
    assert.equal(lookup.statusCode, 200); assert.equal(lookup.json().groupName, 'Public Number');
    const requested = await app.inject({ method: 'POST', url: `/api/groups/${conversation.groupNumber}/join`, headers: auth(member), payload: {} });
    assert.equal(requested.statusCode, 202);
    assert.equal((await app.inject({ method: 'POST', url: `/api/groups/${conversation.id.replace('g-', '')}/join-requests/${requested.json().requestId}`, headers: auth(owner), payload: { approve: false } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: `/api/groups/${conversation.id.replace('g-', '')}/join-requests/${requested.json().requestId}`, headers: auth(owner), payload: { approve: false, reason: '资料不完整' } })).statusCode, 200);
    const mine = await app.inject({ method: 'GET', url: '/api/my-group-join-requests', headers: auth(member) });
    assert.equal(mine.json().requests[0].status, 'rejected');
    assert.equal(mine.json().requests[0].rejectionReason, '资料不完整');
    assert.equal(mine.json().requests[0].groupNumber, conversation.groupNumber);
  });

  it('stores group avatars and exposes group summaries to authorized panel credentials', async () => {
    const owner = user('avatar-owner@example.com'); const member = user('avatar-member@example.com'); const adminUser = user('avatar-admin@example.com');
    for (const id of [owner, member, adminUser]) await accept(id);
    const created = await app.inject({ method: 'POST', url: '/api/groups', headers: auth(owner), payload: { name: 'Avatar Group', joinMode: 'open', memberIds: [] } });
    const group = created.json(); const internalId = group.id.replace('g-', '');
    const avatar = `data:image/webp;base64,${Buffer.from('group-avatar').toString('base64')}`;
    const updated = await app.inject({ method: 'PATCH', url: `/api/groups/${internalId}/settings`, headers: auth(owner), payload: { joinMode: 'open', avatar } });
    assert.equal(updated.statusCode, 200); assert.equal(updated.json().avatar, avatar);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/groups/${internalId}/settings`, headers: auth(member), payload: { joinMode: 'open', avatar } })).statusCode, 403);
    db.prepare('UPDATE users SET platform_admin_at=? WHERE id=?').run(Date.now(), adminUser);
    const listed = await app.inject({ method: 'GET', url: '/api/admin/groups', headers: { 'x-admin-key': rootKey } });
    assert.equal(listed.statusCode, 200); assert.equal(listed.json().groups[0].publicNumber, group.groupNumber); assert.equal(listed.json().groups[0].memberCount, 1);
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/groups/${group.groupNumber}/force-join`, headers: { 'x-admin-key': rootKey }, payload: { userUuid: (db.prepare('SELECT uuid FROM users WHERE id=?').get(adminUser) as { uuid: string }).uuid } })).statusCode, 200);
    assert.ok(db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(Number(internalId), adminUser));
    const cleared = await app.inject({ method: 'PATCH', url: `/api/groups/${internalId}/settings`, headers: auth(owner), payload: { joinMode: 'open', avatar: null } });
    assert.equal(cleared.statusCode, 200); assert.equal(cleared.json().avatar, undefined);
  });

  it('prevents a platform administrator moderating a peer and creates content-free tombstones', async () => {
    const first = user('firstmod@example.com'); const second = user('secondmod@example.com'); const ordinary = user('ordinary@example.com');
    for (const id of [first, second, ordinary]) await accept(id);
    db.prepare('UPDATE users SET platform_admin_at=? WHERE id IN (?,?)').run(Date.now(), first, second);
    assert.equal((await app.inject({ method: 'POST', url: `/api/platform-admin/users/${second}/ban`, headers: auth(first), payload: { banned: true } })).statusCode, 404);
    const group = Number(db.prepare('INSERT INTO chat_groups(owner_id,name,created_at) VALUES (?,?,?)').run(ordinary, 'Governed', Date.now()).lastInsertRowid);
    db.prepare("INSERT INTO group_members(group_id,user_id,joined_at,role) VALUES (?,?,?,'owner')").run(group, ordinary, Date.now());
    db.prepare("INSERT INTO group_members(group_id,user_id,joined_at,role,forced_by) VALUES (?,?,?,'member',?)").run(group, first, Date.now(), first);
    db.prepare('INSERT INTO message_metadata(id,sender_id,group_id,created_at) VALUES (?,?,?,?)').run('opaque-id', ordinary, group, Date.now());
    const removed = await app.inject({ method: 'POST', url: '/api/platform-admin/messages/opaque-id/remove', headers: auth(first), payload: { reason: 'spam' } });
    assert.deepEqual(removed.json(), { removed: true, tombstone: true, contentInspected: false });
    assert.equal(db.prepare('SELECT 1 FROM message_queue WHERE id=?').get('opaque-id'), undefined);
    const metadata = db.prepare('SELECT removal_reason,removed_at FROM message_metadata WHERE id=?').get('opaque-id') as { removal_reason: string; removed_at: number };
    assert.equal(metadata.removal_reason, 'spam'); assert.ok(metadata.removed_at);
  });

  it('allows only the sender to recall a message', async () => {
    const sender = user('recall-sender@example.com'); const recipient = user('recall-recipient@example.com');
    await accept(sender); await accept(recipient);
    db.prepare('INSERT INTO message_metadata(id,sender_id,recipient_id,group_id,created_at) VALUES (?,?,?,NULL,?)').run('recall-id', sender, recipient, Date.now());
    assert.equal((await app.inject({ method: 'POST', url: '/api/messages/recall-id/recall', headers: auth(recipient), payload: {} })).statusCode, 403);
    const recalled = await app.inject({ method: 'POST', url: '/api/messages/recall-id/recall', headers: auth(sender), payload: {} });
    assert.equal(recalled.statusCode, 200);
    assert.ok((db.prepare('SELECT removed_at removedAt FROM message_metadata WHERE id=?').get('recall-id') as { removedAt: number }).removedAt);
    assert.equal((await app.inject({ method: 'POST', url: '/api/messages/recall-id/recall', headers: auth(sender), payload: {} })).statusCode, 409);
  });

  it('routes group messages as distinct per-recipient encrypted envelopes without decrypting', async () => {
    const sender = user('sender@example.com'); const first = user('one@example.com'); const second = user('two@example.com');
    for (const id of [sender, first, second]) await accept(id);
    const group = Number(db.prepare('INSERT INTO chat_groups(owner_id,name,created_at) VALUES (?,?,?)').run(sender, 'Encrypted', Date.now()).lastInsertRowid);
    db.prepare("INSERT INTO group_members(group_id,user_id,joined_at,role) VALUES (?,?,?,'owner')").run(group, sender, Date.now());
    db.prepare("INSERT INTO group_members(group_id,user_id,joined_at,role) VALUES (?,?,?,'member')").run(group, first, Date.now());
    db.prepare("INSERT INTO group_members(group_id,user_id,joined_at,role) VALUES (?,?,?,'member')").run(group, second, Date.now());
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const socket = new WebSocket(`${address.replace('http', 'ws')}/ws?token=${encodeURIComponent(token(sender))}`);
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const accepted = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket response timeout')), 2000);
      socket.once('message', raw => { clearTimeout(timer); resolve(JSON.parse(raw.toString()) as Record<string, unknown>); });
    });
    socket.send(JSON.stringify({ type: 'group-message', id: 'group-opaque', groupId: group, envelopes: [
      { recipientId: first, envelope: { version: 1, algorithm: 'ECDH-P256/AES-256-GCM', ephemeralPublicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, iv: 'iv-one', ciphertext: 'opaque-one' } },
      { recipientId: second, envelope: { version: 1, algorithm: 'ECDH-P256/AES-256-GCM', ephemeralPublicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, iv: 'iv-two', ciphertext: 'opaque-two' } },
    ] }));
    assert.equal((await accepted).recipients, 2);
    const queued = db.prepare('SELECT recipient_id,envelope FROM group_message_queue WHERE message_id=? ORDER BY recipient_id').all('group-opaque') as Array<{ recipient_id: number; envelope: string }>;
    assert.equal(queued.length, 2); assert.notEqual(queued[0]!.envelope, queued[1]!.envelope);
    assert.equal(JSON.parse(queued[0]!.envelope).ciphertext, 'opaque-one'); assert.equal(JSON.parse(queued[1]!.envelope).ciphertext, 'opaque-two');
    assert.equal(db.prepare('SELECT 1 FROM message_metadata WHERE id=? AND group_id=?').get('group-opaque', group) !== undefined, true);
    socket.close();
  });

  it('dissolves a group only for its owner and removes all group data', async () => {
    const owner = user('dissolve-owner@example.com'); const member = user('dissolve-member@example.com');
    await accept(owner); await accept(member);
    const created = await app.inject({ method: 'POST', url: '/api/groups', headers: auth(owner), payload: { name: 'Doomed', joinMode: 'approval' } });
    assert.equal(created.statusCode, 201);
    const groupId = created.json().id.replace('g-', '');
    const requested = await app.inject({ method: 'POST', url: `/api/groups/${groupId}/join`, headers: auth(member), payload: {} });
    assert.equal(requested.statusCode, 202);
    assert.equal((await app.inject({ method: 'POST', url: `/api/groups/${groupId}/join-requests/${requested.json().requestId}`, headers: auth(owner), payload: { approve: true } })).statusCode, 200);
    db.prepare('INSERT INTO message_metadata(id,sender_id,group_id,created_at) VALUES (?,?,?,?)').run('dissolve-msg', owner, Number(groupId), Date.now());
    db.prepare('INSERT INTO message_tombstones(id,recipient_id,message_id,sender_id,group_id,event_type,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)').run('dissolve-tomb', member, 'dissolve-msg', owner, Number(groupId), 'message-recalled', Date.now(), Date.now() + 86400000);
    db.prepare('INSERT INTO group_message_queue(delivery_id,message_id,sender_id,recipient_id,group_id,envelope,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)').run('dissolve-q', 'dissolve-msg', owner, member, Number(groupId), '{}', Date.now(), Date.now() + 86400000);
    db.prepare('INSERT INTO user_mutes(user_id,group_id,expires_at,created_by,created_at) VALUES (?,?,?,?,?)').run(member, Number(groupId), Date.now() + 3600000, owner, Date.now());
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/groups/${groupId}`, headers: auth(member), payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/groups/${groupId}`, headers: auth(owner), payload: {} })).statusCode, 204);
    assert.equal(db.prepare('SELECT 1 FROM chat_groups WHERE id=?').get(groupId), undefined);
    assert.equal(db.prepare('SELECT 1 FROM group_members WHERE group_id=?').get(groupId), undefined);
    assert.equal(db.prepare('SELECT 1 FROM message_metadata WHERE group_id=?').get(groupId), undefined);
    assert.equal(db.prepare('SELECT 1 FROM message_tombstones WHERE group_id=?').get(groupId), undefined);
    assert.equal(db.prepare('SELECT 1 FROM group_message_queue WHERE group_id=?').get(groupId), undefined);
    assert.equal(db.prepare('SELECT 1 FROM user_mutes WHERE group_id=?').get(groupId), undefined);
    assert.equal(db.prepare('SELECT 1 FROM group_join_requests WHERE group_id=?').get(groupId), undefined);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/groups/${groupId}`, headers: auth(owner), payload: {} })).statusCode, 404);
    assert.equal((db.prepare("SELECT COUNT(*) count FROM audit_log WHERE action='group.delete'").get() as { count: number }).count, 1);
  });
});

describe('announcements', () => {
  it('publishes, lists to authenticated users, archives, and audits', async () => {
    const reader = user('reader@example.com');
    const published = await app.inject({ method: 'POST', url: '/api/admin/announcements', headers: { 'x-admin-key': rootKey }, payload: { title: 'Maintenance', body: 'At midnight.' } });
    assert.equal(published.statusCode, 201);
    assert.equal((await app.inject({ method: 'GET', url: '/api/announcements', headers: auth(reader) })).json().announcements.length, 1);
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/announcements/${published.json().id}/archive`, headers: { 'x-admin-key': rootKey }, payload: {} })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/announcements', headers: auth(reader) })).json().announcements.length, 0);
    assert.equal((db.prepare("SELECT COUNT(*) count FROM audit_log WHERE action LIKE 'announcement.%'").get() as { count: number }).count, 2);
  });
});
