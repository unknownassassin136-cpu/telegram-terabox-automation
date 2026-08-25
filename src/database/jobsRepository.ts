import { Database as SqlJsDatabase } from 'sql.js';
import { Logger } from '../utils/logger';
import { saveDatabase } from './database';

export type JobStatus =
  | 'DETECTED'
  | 'QUEUED'
  | 'SENT_TO_BOT'
  | 'WAITING_FOR_VIDEO'
  | 'VIDEO_RECEIVED'
  | 'UPLOADING'
  | 'COMPLETED'
  | 'FAILED';

export interface Job {
  id: number;
  source_chat_id: string;
  source_message_id: number;
  source_url: string;
  normalized_url: string;
  status: JobStatus;
  bot_request_message_id: number | null;
  video_message_id: number | null;
  destination_message_id: number | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  error_message: string | null;
}

export interface CreateJobData {
  sourceChatId: string;
  sourceMessageId: number;
  sourceUrl: string;
  normalizedUrl: string;
}

/**
 * Helper to convert sql.js result rows to Job objects.
 * sql.js returns results as { columns: string[], values: any[][] }.
 */
function rowToJob(columns: string[], values: any[]): Job {
  const row: any = {};
  columns.forEach((col, i) => {
    row[col] = values[i];
  });
  return row as Job;
}

function queryOne(db: SqlJsDatabase, sql: string, params?: any[]): Job | undefined {
  const result = db.exec(sql, params);
  if (result.length === 0 || result[0].values.length === 0) return undefined;
  return rowToJob(result[0].columns, result[0].values[0]);
}

function queryAll(db: SqlJsDatabase, sql: string, params?: any[]): Job[] {
  const result = db.exec(sql, params);
  if (result.length === 0) return [];
  return result[0].values.map((row) => rowToJob(result[0].columns, row));
}

export class JobsRepository {
  private db: SqlJsDatabase;
  private logger: Logger;

  constructor(db: SqlJsDatabase, logger: Logger) {
    this.db = db;
    this.logger = logger.child({ module: 'JobsRepository' });
  }

  /**
   * Creates a new job. Returns null if the URL already has an existing job (duplicate protection).
   */
  createJob(data: CreateJobData): Job | null {
    // Check for existing job with this URL
    const existing = queryOne(
      this.db,
      'SELECT * FROM jobs WHERE normalized_url = ?',
      [data.normalizedUrl]
    );

    if (existing) {
      this.logger.info({ url: data.normalizedUrl }, 'Job already exists for this URL — skipping');
      return null;
    }

    try {
      this.db.run(
        `INSERT INTO jobs (source_chat_id, source_message_id, source_url, normalized_url, status)
         VALUES (?, ?, ?, ?, 'DETECTED')`,
        [data.sourceChatId, data.sourceMessageId, data.sourceUrl, data.normalizedUrl]
      );

      this.persist();

      // Get the inserted row
      const job = queryOne(
        this.db,
        'SELECT * FROM jobs WHERE normalized_url = ?',
        [data.normalizedUrl]
      );

      if (job) {
        this.logger.info({ jobId: job.id, url: data.normalizedUrl }, 'Job created');
      }
      return job || null;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('UNIQUE constraint failed')) {
        this.logger.info({ url: data.normalizedUrl }, 'Duplicate URL caught by DB constraint');
        return null;
      }
      throw err;
    }
  }

  updateStatus(id: number, status: JobStatus): void {
    this.db.run(
      "UPDATE jobs SET status = ?, updated_at = datetime('now') WHERE id = ?",
      [status, id]
    );
    this.persist();
    this.logger.info({ jobId: id, status }, 'Job status updated');
  }

  getById(id: number): Job | undefined {
    return queryOne(this.db, 'SELECT * FROM jobs WHERE id = ?', [id]);
  }

  getByUrl(normalizedUrl: string): Job | undefined {
    return queryOne(this.db, 'SELECT * FROM jobs WHERE normalized_url = ?', [normalizedUrl]);
  }

  /**
   * Returns the oldest job in DETECTED or QUEUED state, or undefined if none.
   */
  getNextQueued(): Job | undefined {
    return queryOne(
      this.db,
      "SELECT * FROM jobs WHERE status IN ('DETECTED', 'QUEUED') ORDER BY created_at ASC LIMIT 1"
    );
  }

  /**
   * Returns all jobs currently in SENT_TO_BOT or WAITING_FOR_VIDEO state.
   */
  getPendingJobs(): Job[] {
    return queryAll(
      this.db,
      "SELECT * FROM jobs WHERE status IN ('SENT_TO_BOT', 'WAITING_FOR_VIDEO') ORDER BY created_at ASC"
    );
  }

  /**
   * Returns the currently active job (being processed by Auto-MD), if any.
   */
  getActiveJob(): Job | undefined {
    return queryOne(
      this.db,
      "SELECT * FROM jobs WHERE status IN ('SENT_TO_BOT', 'WAITING_FOR_VIDEO', 'VIDEO_RECEIVED', 'UPLOADING') ORDER BY updated_at DESC LIMIT 1"
    );
  }

  urlExists(normalizedUrl: string): boolean {
    const result = this.db.exec(
      'SELECT 1 FROM jobs WHERE normalized_url = ?',
      [normalizedUrl]
    );
    return result.length > 0 && result[0].values.length > 0;
  }

  setBotRequestMessageId(id: number, msgId: number): void {
    this.db.run(
      "UPDATE jobs SET bot_request_message_id = ?, updated_at = datetime('now') WHERE id = ?",
      [msgId, id]
    );
    this.persist();
  }

  setVideoMessageId(id: number, msgId: number): void {
    this.db.run(
      "UPDATE jobs SET video_message_id = ?, updated_at = datetime('now') WHERE id = ?",
      [msgId, id]
    );
    this.persist();
  }

  setDestinationMessageId(id: number, msgId: number): void {
    this.db.run(
      "UPDATE jobs SET destination_message_id = ?, updated_at = datetime('now') WHERE id = ?",
      [msgId, id]
    );
    this.persist();
  }

  setError(id: number, error: string): void {
    this.db.run(
      "UPDATE jobs SET error_message = ?, updated_at = datetime('now') WHERE id = ?",
      [error, id]
    );
    this.persist();
  }

  incrementAttempt(id: number): void {
    this.db.run(
      "UPDATE jobs SET attempt_count = attempt_count + 1, updated_at = datetime('now') WHERE id = ?",
      [id]
    );
    this.persist();
  }

  getTimedOutJobs(timeoutMinutes: number): Job[] {
    return queryAll(
      this.db,
      `SELECT * FROM jobs
       WHERE status = 'WAITING_FOR_VIDEO'
         AND datetime(updated_at, '+' || ? || ' minutes') < datetime('now')`,
      [timeoutMinutes]
    );
  }

  /**
   * Returns jobs stuck in VIDEO_RECEIVED or UPLOADING (crashed mid-transfer).
   */
  getStaleTransferJobs(): Job[] {
    return queryAll(
      this.db,
      "SELECT * FROM jobs WHERE status IN ('VIDEO_RECEIVED', 'UPLOADING')"
    );
  }

  /**
   * Saves the database to disk after mutations.
   */
  private persist(): void {
    saveDatabase(this.logger);
  }
}
