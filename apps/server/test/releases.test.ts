import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';

let app: FastifyInstance;
let db: DatabaseSync;
let workDir: string;
const rootKey = 'root-key-with-sufficient-random-looking-content';
function fakeApk(versionName: string, versionCode: number) {
  const zip = new AdmZip();
  zip.addFile('AndroidManifest.xml', Buffer.from('manifest'));
  zip.addFile('assets/version.json', Buffer.from(JSON.stringify({ packageId: 'com.lanmiao.express', versionName, versionCode })));
  zip.addFile('classes.dex', randomBytes(55_000));
  return zip.toBuffer();
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'lanmiao-releases-'));
  db = openDatabase(join(workDir, 'lanmiao.sqlite'));
  app = await buildApp({
    host: '127.0.0.1', port: 3210, databasePath: join(workDir, 'lanmiao.sqlite'),
    jwtSecret: 'test-secret-that-is-at-least-32-characters', rootKeyHash: sha256(rootKey),
    offlineTtlSeconds: 60, emailCodeTtlSeconds: 600,
  }, db);
});
after(async () => { await app.close(); rmSync(workDir, { recursive: true, force: true }); });

describe('app release publishing and updates', () => {
  it('publishes an APK, serves it for download and reports it as latest', async () => {
    const apk = fakeApk('1.2.0', 120);
    const published = await app.inject({
      method: 'POST', url: '/api/admin/releases', headers: { 'x-admin-key': rootKey },
      payload: { versionName: '1.2.0', versionCode: 120, fileName: 'lanmiao-1.2.0.apk', notes: '修复若干问题', forceUpdate: true, apkBase64: apk.toString('base64') },
    });
    assert.equal(published.statusCode, 201);
    assert.equal(published.json().versionCode, 120);

    const latest = await app.inject({ method: 'GET', url: '/api/releases/latest' });
    assert.equal(latest.statusCode, 200);
    const release = latest.json().release;
    assert.equal(release.versionName, '1.2.0');
    assert.equal(release.versionCode, 120);
    assert.equal(release.forceUpdate, true);
    assert.equal(release.sha256, sha256(apk));
    assert.equal(release.downloadUrl, `/api/releases/${release.id}/download`);

    const outdated = await app.inject({ method: 'GET', url: '/api/disclaimer', headers: { 'x-app-version-code': '100' } });
    assert.equal(outdated.statusCode, 426); assert.equal(outdated.json().code, 'UPDATE_REQUIRED');
    assert.equal((await app.inject({ method: 'GET', url: '/api/disclaimer', headers: { 'x-app-version-code': '999' } })).statusCode, 200);

    const download = await app.inject({ method: 'GET', url: `/api/releases/${release.id}/download` });
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers['content-type'], 'application/vnd.android.package-archive');
    assert.equal(Buffer.from(download.rawPayload).length, apk.length);
    assert.equal(sha256(Buffer.from(download.rawPayload)), sha256(apk));
  });

  it('rejects duplicate version codes, bad payloads and non-root publishers', async () => {
    const subordinate = (await app.inject({ method: 'POST', url: '/api/admin/keys', headers: { 'x-admin-key': rootKey }, payload: { name: 'viewer', scopes: ['users:read'] } })).json().key as string;
    const payload = { versionName: '1.1.0', versionCode: 110, fileName: 'lanmiao.apk', apkBase64: fakeApk('1.1.0', 110).toString('base64') };
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/releases', headers: { 'x-admin-key': subordinate }, payload })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/releases', headers: { 'x-admin-key': rootKey }, payload: { versionName: 'x', versionCode: 0, fileName: 'bad.apk', apkBase64: fakeApk('x', 1).toString('base64') } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/releases', headers: { 'x-admin-key': rootKey }, payload: { versionName: '1.3.0', versionCode: 130, fileName: 'fake.txt', apkBase64: fakeApk('1.3.0', 130).toString('base64') } })).json().error, '只能发布 APK 文件');
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/releases', headers: { 'x-admin-key': rootKey }, payload: { versionName: '1.3.0', versionCode: 130, fileName: 'fake.apk', apkBase64: 'not-base64!!' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/releases', headers: { 'x-admin-key': rootKey }, payload: { versionName: '1.2.0', versionCode: 120, fileName: 'duplicate.apk', apkBase64: fakeApk('1.2.0', 120).toString('base64') } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/releases', headers: { 'x-admin-key': rootKey }, payload: { versionName: '9.9.9', versionCode: 999, fileName: 'mismatch.apk', apkBase64: fakeApk('1.2.3', 123).toString('base64') } })).statusCode, 400);
  });

  it('archives a release and removes it from downloads', async () => {
    const published = await app.inject({
      method: 'POST', url: '/api/admin/releases', headers: { 'x-admin-key': rootKey },
      payload: { versionName: '1.0.0', versionCode: 100, fileName: 'lanmiao-1.0.0.apk', notes: '首版', forceUpdate: false, apkBase64: fakeApk('1.0.0', 100).toString('base64') },
    });
    const oldId = published.json().id as number;
    const soft = await app.inject({ method: 'POST', url: '/api/admin/releases', headers: { 'x-admin-key': rootKey }, payload: { versionName: '1.4.0', versionCode: 140, fileName: 'lanmiao.apk', forceUpdate: false, apkBase64: fakeApk('1.4.0', 140).toString('base64') } });
    assert.equal(soft.statusCode, 201);
    const activeId = soft.json().id as number;
    assert.equal((await app.inject({ method: 'GET', url: `/api/releases/${oldId}/download` })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/disclaimer', headers: { 'x-app-version-code': '130' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/disclaimer', headers: { 'x-app-version-code': '140' } })).statusCode, 200);
    const archived = await app.inject({ method: 'POST', url: `/api/admin/releases/${activeId}/archive`, headers: { 'x-admin-key': rootKey }, payload: {} });
    assert.equal(archived.statusCode, 200);
    assert.equal(archived.json().deleted, true);
    assert.equal((await app.inject({ method: 'GET', url: `/api/releases/${activeId}/download` })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/releases/latest' })).json().release, null);
    assert.equal((await app.inject({ method: 'GET', url: '/api/disclaimer', headers: { 'x-app-version-code': '1' } })).statusCode, 200);
    const list = await app.inject({ method: 'GET', url: '/api/admin/releases', headers: { 'x-admin-key': rootKey } });
    assert.equal(list.statusCode, 200);
    const archivedEntry = list.json().releases.find((item: { id: number }) => item.id === activeId);
    assert.ok(archivedEntry);
    assert.ok(archivedEntry.archivedAt);
  });
});
