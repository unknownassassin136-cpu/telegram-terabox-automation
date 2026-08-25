import { TelegramClient } from 'telegram';
import { NewMessage } from 'telegram/events';
import { Api } from 'telegram/tl';
import { Logger } from '../utils/logger';
import { ResolvedEntities } from './client';

/**
 * Sends a TeraBox URL to the Auto-MD processing bot.
 *
 * Sends ONLY the URL — no source caption, no custom text, no commands.
 * Returns the message ID of the sent message for tracking.
 */
export async function sendUrlToBot(
  client: TelegramClient,
  entities: ResolvedEntities,
  url: string,
  logger: Logger
): Promise<number> {
  const botLogger = logger.child({ module: 'ProcessingBot' });

  botLogger.info({ url }, 'Sending URL to Auto-MD bot');

  const result = await client.sendMessage(entities.processingBot, {
    message: url,
  });

  botLogger.info({ messageId: result.id, url }, 'URL sent to Auto-MD bot');
  return result.id;
}

/**
 * Determines whether a Telegram message contains actual video media.
 *
 * Accepts:
 * - Native Telegram video (MessageMediaDocument with video attributes)
 * - MP4 documents sent as files
 * - Any document with video/* MIME type
 *
 * Rejects:
 * - Text-only messages (e.g. "Analyzing link 1/1...")
 * - Images / photos
 * - Stickers
 * - GIFs (animated documents without video MIME)
 * - Other non-video documents
 */
export function isVideoMessage(message: Api.Message): boolean {
  if (!message.media) return false;

  // Check for MessageMediaDocument (videos, documents)
  if (message.media instanceof Api.MessageMediaDocument) {
    const doc = message.media.document;
    if (doc instanceof Api.Document) {
      const mimeType = doc.mimeType || '';

      // Check MIME type — must be video/*
      if (mimeType.startsWith('video/')) return true;

      // Also check for video attributes (some bots send as document with video attrs)
      for (const attr of doc.attributes) {
        if (attr instanceof Api.DocumentAttributeVideo) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Registers a listener for messages from the Auto-MD bot.
 *
 * Filters:
 * - Only processes messages from the bot's private chat.
 * - Ignores text-only messages (status updates like "Analyzing...").
 * - Ignores non-video media (images, stickers, GIFs).
 * - Calls onVideoReceived only for actual video media.
 *
 * Because only one job is active at a time (serial processing),
 * any video from the bot deterministically belongs to the current active job.
 *
 * @param onVideoReceived - Callback with the video message when genuine video arrives.
 */
export function startBotResponseListener(
  client: TelegramClient,
  entities: ResolvedEntities,
  onVideoReceived: (message: Api.Message) => void,
  logger: Logger,
  onErrorReceived?: (errorMessage: string) => void
): void {
  const botLogger = logger.child({ module: 'BotResponseListener' });

  client.addEventHandler(
    async (event) => {
      try {
        const message = event.message as Api.Message;
        if (!message) return;

        const senderIdStr = message.senderId?.toString();
        const peerIdStr = message.peerId ? ('userId' in message.peerId ? message.peerId.userId.toString() : '') : '';
        const botIdStr = entities.processingBot.id.toString();

        botLogger.info(
          { 
            messageId: message.id, 
            senderId: senderIdStr, 
            peerId: peerIdStr, 
            botId: botIdStr,
            text: message.message?.substring(0, 50) 
          }, 
          'GLOBAL_MESSAGE_IN'
        );

        // Manually filter to only process messages from the bot.
        // We check both peerId (the chat) and senderId to be safe.
        if (senderIdStr !== botIdStr && peerIdStr !== botIdStr) {
          return; // Ignore messages from other chats
        }

        // Log all bot messages for debugging
        const hasMedia = !!message.media;
        const textPreview = message.message
          ? message.message.substring(0, 120)
          : '(no text)';

        botLogger.info(
          { messageId: message.id, hasMedia, text: textPreview },
          'Bot message received'
        );

        // Check if the bot sent an error message (invalid/unsupported link)
        const isErrorMessage = textPreview.includes('could not be processed') || textPreview.includes('invalid or unsupported');
        if (isErrorMessage && onErrorReceived) {
          botLogger.warn({ messageId: message.id, text: textPreview }, 'Bot returned an error for this link');
          onErrorReceived(message.message || 'Unknown bot error');
          return;
        }

        // Skip text-only messages (e.g. "Analyzing link 1/1...")
        if (!message.media) {
          botLogger.info(
            { messageId: message.id, text: textPreview },
            'Ignored text-only bot message (status/progress)'
          );
          return;
        }

        // Check if this is actual video
        if (isVideoMessage(message)) {
          botLogger.info({ messageId: message.id }, 'Video detected from Auto-MD bot');
          onVideoReceived(message);
        } else {
          botLogger.info(
            { messageId: message.id },
            'Ignored non-video media from bot (image/sticker/gif/other)'
          );
        }
      } catch (err) {
        botLogger.error({ err }, 'Error processing bot response');
      }
    },
    new NewMessage({}) // Listen to all, filter manually
  );

  botLogger.info('Bot response listener active');
}
