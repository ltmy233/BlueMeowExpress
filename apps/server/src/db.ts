// SQLite 打开 + 迁移：启动时按文件名顺序逐个执行 .sql，已执行的跳过
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt, randomUUID } from 'node:crypto';

export type Database = DatabaseSync;

export function openDatabase(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const migrationDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const files = readdirSync(migrationDir).filter((file) => file.endsWith('.sql')).sort();
  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  for (const file of files) {
    if (applied.get(file)) continue;
    const sql = readFileSync(join(migrationDir, file), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      if (file === '003_user_uuid.sql') {
        const missing = db.prepare('SELECT id FROM users WHERE uuid IS NULL').all() as Array<{ id: number }>;
        const assign = db.prepare('UPDATE users SET uuid = ? WHERE id = ? AND uuid IS NULL');
        for (const row of missing) assign.run(randomUUID(), row.id);
        db.exec(`
          CREATE UNIQUE INDEX users_uuid_unique ON users(uuid);
          CREATE TRIGGER users_uuid_required
          BEFORE INSERT ON users
          WHEN NEW.uuid IS NULL
          BEGIN
            SELECT RAISE(ABORT, 'user uuid is required');
          END;
          CREATE TRIGGER users_uuid_immutable
          BEFORE UPDATE OF uuid ON users
          WHEN OLD.uuid IS NOT NEW.uuid
          BEGIN
            SELECT RAISE(ABORT, 'user uuid is immutable');
          END;
        `);
      }
      if (file === '015_group_public_numbers_and_request_reasons.sql') {
        const missing = db.prepare('SELECT id FROM chat_groups WHERE public_number IS NULL').all() as Array<{ id: number }>;
        const assign = db.prepare('UPDATE chat_groups SET public_number=? WHERE id=? AND public_number IS NULL');
        const exists = db.prepare('SELECT 1 FROM chat_groups WHERE public_number=?');
        for (const row of missing) {
          let publicNumber: string;
          do publicNumber = String(randomInt(100_000_000, 1_000_000_000));
          while (exists.get(publicNumber));
          assign.run(publicNumber, row.id);
        }
      }
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(file, Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
