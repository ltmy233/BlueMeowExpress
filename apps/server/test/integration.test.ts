import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { hashPassword, sha256 } from '../src/security.js';

let app: FastifyInstance; let db: DatabaseSync;
const identity = { algorithm: 'ECDH-P256', publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, fingerprint: '1234567890abcdef' };
beforeEach(async () => { db = openDatabase(':memory:'); app = await buildApp({ host: '127.0.0.1', port: 0, databasePath: ':memory:', jwtSecret: 'test-secret-that-is-at-least-32-characters', rootKeyHash: sha256('root-key-with-sufficient-random-looking-content'), offlineTtlSeconds: 60, emailCodeTtlSeconds: 600 }, db); });
afterEach(async () => app.close());

describe('client HTTP contract', () => {
  it('allows the Capacitor version header during CORS preflight', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth/login',
      headers: {
        origin: 'https://localhost',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-app-version-code',
      },
    });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['access-control-allow-origin'], 'https://localhost');
    assert.match(String(response.headers['access-control-allow-headers']), /X-App-Version-Code/i);
  });

  it('returns accessToken-only login, app profile, disclaimer and conversation wrappers', async () => {
    const now = Date.now(); const password = 'password-12345';
    const uuid = randomUUID();
    const id = Number(db.prepare('INSERT INTO users(uuid,email,password_hash,display_name,public_identity,identity_fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(uuid, 'client@example.com', await hashPassword(password), 'Client', JSON.stringify(identity), identity.fingerprint, now, now).lastInsertRowid);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'client@example.com', password, identity } });
    assert.equal(login.statusCode, 200); assert.ok(login.json().accessToken); assert.equal(login.json().refreshToken, undefined); assert.equal(login.json().user.id, String(id)); assert.equal(login.json().user.uuid, uuid);
    const headers = { authorization: `Bearer ${login.json().accessToken}` };
    assert.equal((await app.inject({ method: 'GET', url: '/api/profile', headers })).json().name, 'Client');
    const avatar = `data:image/webp;base64,${Buffer.alloc(2_000).toString('base64')}`;
    const updated = await app.inject({ method: 'PATCH', url: '/api/profile', headers, payload: { name: 'Client', bio: '', gender: 'private', avatar } });
    assert.equal(updated.statusCode, 200); assert.equal(updated.json().avatar, avatar);
    assert.equal(typeof (await app.inject({ method: 'GET', url: '/api/disclaimer', headers })).json().content, 'string');
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/conversations', headers })).json(), { conversations: [] });
  });

  it('reports bad login credentials clearly and supports email-code login', async () => {
    const now = Date.now(); const email = 'recovery@example.com'; const code = '654321';
    const id = Number(db.prepare('INSERT INTO users(uuid,email,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), email, await hashPassword('password-12345'), 'Recovery', now, now).lastInsertRowid);
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'wrong-password', identity } });
    assert.equal(bad.statusCode, 401); assert.equal(bad.json().error, '邮箱或密码不正确');
    db.prepare('INSERT INTO password_reset_codes(email,code_hash,expires_at,attempts,created_at) VALUES (?,?,?,0,?)').run(email, sha256(code), now + 60_000, now);
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/password-reset-login', payload: { email, code: '111111', identity } });
    assert.equal(wrong.statusCode, 400); assert.equal(wrong.json().error, '验证码错误');
    const recovered = await app.inject({ method: 'POST', url: '/api/auth/password-reset-login', payload: { email, code, identity } });
    assert.equal(recovered.statusCode, 200); assert.equal(recovered.json().user.id, String(id)); assert.ok(recovered.json().accessToken);
  });

  it('assigns a UUID during registration and exposes it in the profile', async () => {
    const email = 'new@example.com'; const code = '123456'; const now = Date.now();
    db.prepare('INSERT INTO email_codes(email,code_hash,expires_at,attempts,created_at) VALUES (?,?,?,0,?)').run(email, sha256(code), now + 60_000, now);
    const disclaimer = (await app.inject({ method: 'GET', url: '/api/disclaimer' })).json();
    const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'password-12345', displayName: 'New User', code, identity, disclaimerVersion: disclaimer.version } });
    assert.equal(response.statusCode, 201);
    assert.match(response.json().user.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const stored = db.prepare('SELECT uuid FROM users WHERE email=?').get(email) as { uuid: string };
    assert.equal(stored.uuid, response.json().user.uuid);
  });
});
