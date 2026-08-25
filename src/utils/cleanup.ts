import fs from 'fs';
import path from 'path';
import { Logger } from './logger';

/**
 * Ensures required directories exist, creating them if necessary.
 */
export function ensureDirectories(dirs: string[], logger: Logger): void {
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info({ dir }, 'Created directory');
    }
  }
}

/**
 * Removes all files in the temp directory on startup.
 * Does not remove subdirectories.
 */
export function cleanTempDir(tempDir: string, logger: Logger): void {
  if (!fs.existsSync(tempDir)) return;

  const entries = fs.readdirSync(tempDir);
  let cleaned = 0;

  for (const entry of entries) {
    const filePath = path.join(tempDir, entry);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        fs.unlinkSync(filePath);
        cleaned++;
        logger.debug({ file: entry }, 'Removed stale temp file');
      }
    } catch (err) {
      logger.warn({ err, file: entry }, 'Failed to clean temp file');
    }
  }

  if (cleaned > 0) {
    logger.info({ count: cleaned }, 'Cleaned stale temp files');
  }
}
