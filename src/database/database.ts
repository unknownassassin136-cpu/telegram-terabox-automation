import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import path from 'path';
import fs from 'fs';
import { Logger } from '../utils/logger';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  source_chat_id          TEXT    NOT NULL,
  source_message_id       INTEGER NOT NULL,
  source_url              TEXT    NOT NULL,
  normalized_url          TEXT    NOT NULL UNIQUE,
  status                  TEXT    NOT NULL DEFAULT 'DETECTED',
  bot_request_message_id  INTEGER,
  video_message_id        INTEGER,
  destination_message_id  INTEGER,
  attempt_count           INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT    NOT NULL DEFAULT (datetime('now')),
  error_message           TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_normalized_url ON jobs(normalized_url);
`;

let dbInstance: SqlJsDatabase | null = null;
let dbPath: string = '';

/**
 * Initializes the SQLite database using sql.js (pure JS, no native compilation).
 * Loads existing data from disk if the file exists.
 */
export async function initDatabase(dbFilePath: string, logger: Logger): Promise<SqlJsDatabase> {
  const dir = path.dirname(dbFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const SQL = await initSqlJs();

  let db: SqlJsDatabase;
  if (fs.existsSync(dbFilePath)) {
    const fileBuffer = fs.readFileSync(dbFilePath);
    db = new SQL.Database(fileBuffer);
    logger.info({ path: dbFilePath }, 'Database loaded from disk');
  } else {
    db = new SQL.Database();
    logger.info({ path: dbFilePath }, 'New database created');
  }

  db.run(SCHEMA);

  dbInstance = db;
  dbPath = dbFilePath;

  // Save to disk after schema init
  saveDatabase(logger);

  logger.info({ path: dbFilePath }, 'Database initialized');
  return db;
}

/**
 * Persists the in-memory database to disk.
 * sql.js operates in-memory; we must explicitly write changes to the file.
 */
export function saveDatabase(logger: Logger): void {
  if (!dbInstance || !dbPath) return;

  try {
    const data = dbInstance.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  } catch (err) {
    logger.error({ err }, 'Failed to save database to disk');
  }
}

/**
 * Returns the current database instance.
 */
export function getDatabase(): SqlJsDatabase {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return dbInstance;
}

/**
 * Closes the database and saves final state.
 */
export function closeDatabase(logger: Logger): void {
  if (dbInstance) {
    saveDatabase(logger);
    dbInstance.close();
    dbInstance = null;
    logger.info('Database closed');
  }
}
