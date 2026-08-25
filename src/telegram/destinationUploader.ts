import { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import { Logger } from '../utils/logger';
import { ResolvedEntities } from './client';

/**
 * Uploads a video file to the destination channel as a completely NEW message.
 *
 * Critical requirements:
 * - Uses sendFile(), NOT forwardMessages()
 * - Caption is empty — no bot metadata, no source info, no filenames
 * - No forwarded-from header
 * - Original video quality is preserved (no re-encoding)
 *
 * @returns The message ID of the uploaded message in the destination channel.
 */
export async function uploadVideoToDestination(
  client: TelegramClient,
  entities: ResolvedEntities,
  videoFilePath: string,
  logger: Logger
): Promise<number> {
  const uploadLogger = logger.child({ module: 'DestinationUploader' });

  uploadLogger.info({ destination: 'destination channel' }, 'Uploading video to destination...');

  const result = await client.sendFile(entities.destinationChannel, {
    file: videoFilePath,
    caption: '',          // Empty caption — no metadata
    forceDocument: false, // Send as video, not as file attachment
    workers: 4,           // Parallel upload workers for speed
  });

  uploadLogger.info(
    { messageId: result.id },
    'Video uploaded to destination channel'
  );

  return result.id;
}
