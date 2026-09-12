import { buildApp } from './src/app.js';
import { openDatabase } from './src/db.js';
import { sha256 } from './src/security.js';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const db: DatabaseSync = openDatabase(':memory:');
const app = await buildApp({ host: '127.0.0.1', port: 3210, databasePath: ':memory:', jwtSecret: 'test-secret-that-is-at-least-32-characters', rootKeyHash: sha256('root-key-with-sufficient-random-looking-content'), offlineTtlSeconds: 60, emailCodeTtlSeconds: 600 }, db);
const now = Date.now();
const owner = Number(db.prepare('INSERT INTO users(uuid,email,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), 'o@x.com', 'hash', 'O', now, now).lastInsertRowid);
db.prepare('UPDATE users SET platform_admin_at=? WHERE id=?').run(Date.now(), owner);
const tok = app.jwt.sign({ sub: owner });
await app.inject({ method: 'POST', url: '/api/disclaimer/accept', headers: { authorization: `Bearer ${tok}` }, payload: { version: (await app.inject({ method: 'GET', url: '/api/disclaimer' })).json().version } });
const created = await app.inject({ method: 'POST', url: '/api/groups', headers: { authorization: `Bearer ${tok}` }, payload: { name: 'Public Number', joinMode: 'approval', memberIds: [] } });
console.log('status', created.statusCode);
console.log('body', JSON.stringify(created.json()));
const row = db.prepare('SELECT id,public_number FROM chat_groups').all();
console.log('db groups', JSON.stringify(row));
await app.close();