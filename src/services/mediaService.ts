import { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Logger } from '../utils/logger';

/**
 * Downloads video media from a Telegram message to a temporary file.
 *
 * Uses GramJS's downloadMedia which preserves the original file quality —
 * no re-encoding occurs.
 *
 * @returns Absolute path to the downloaded temporary file.
 */
export async function downloadVideo(
  client: TelegramClient,
  message: Api.Message,
  tempDir: string,
  logger: Logger
): Promise<string> {
  const mediaLogger = logger.child({ module: 'MediaService' });

  // Generate a unique temp filename
  const uniqueId = crypto.randomBytes(8).toString('hex');
  const extension = getVideoExtension(message);
  const tempPath = path.join(tempDir, `video_${uniqueId}${extension}`);

  // Ensure temp directory exists
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  mediaLogger.info({ tempPath, messageId: message.id }, 'Downloading video...');

  const buffer = await client.downloadMedia(message);

  if (!buffer || (Buffer.isBuffer(buffer) && buffer.length === 0)) {
    throw new Error('Downloaded video is empty');
  }

  // buffer may be a Buffer or string (path)
  if (Buffer.isBuffer(buffer)) {
    fs.writeFileSync(tempPath, buffer);
  } else if (typeof buffer === 'string') {
    // If downloadMedia returned a file path, copy it
    fs.copyFileSync(buffer, tempPath);
  } else {
    throw new Error('Unexpected download result type');
  }

  const fileSize = fs.statSync(tempPath).size;
  mediaLogger.info(
    { tempPath, sizeBytes: fileSize, sizeMB: (fileSize / 1024 / 1024).toFixed(2) },
    'Video downloaded'
  );

  return tempPath;
}

/**
 * Safely deletes a temporary file.
 */
export function deleteTemp(filePath: string, logger: Logger): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.debug({ filePath }, 'Temp file deleted');
    }
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to delete temp file');
  }
}

/**
 * Determines the file extension from a video message's media attributes.
 */
function getVideoExtension(message: Api.Message): string {
  if (message.media instanceof Api.MessageMediaDocument) {
    const doc = message.media.document;
    if (doc instanceof Api.Document) {
      // Check for filename attribute
      for (const attr of doc.attributes) {
        if (attr instanceof Api.DocumentAttributeFilename) {
          const ext = path.extname(attr.fileName);
          if (ext) return ext;
        }
      }
      // Fallback based on MIME type
      if (doc.mimeType === 'video/mp4') return '.mp4';
      if (doc.mimeType === 'video/x-matroska') return '.mkv';
      if (doc.mimeType === 'video/webm') return '.webm';
    }
  }
  return '.mp4'; // Default
}
