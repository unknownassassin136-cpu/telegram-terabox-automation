import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';
import bigInt from 'big-integer';
import { Config } from '../config';
import { Logger } from '../utils/logger';
import type { Entity } from 'telegram/define';

let clientInstance: TelegramClient | null = null;

export interface ResolvedEntities {
  sourceChannels: Entity[];
  processingBot: Entity;
  destinationChannel: Entity;
}

/**
 * Creates and connects the Telegram client using the StringSession from config.
 */
export async function connectClient(config: Config, logger: Logger): Promise<TelegramClient> {
  const clientLogger = logger.child({ module: 'TelegramClient' });

  const session = new StringSession(config.telegramSession);
  const client = new TelegramClient(session, config.telegramApiId, config.telegramApiHash, {
    connectionRetries: 5,
    retryDelay: 1000,
  });

  clientLogger.info('Connecting to Telegram...');
  await client.connect();

  if (!await client.checkAuthorization()) {
    throw new Error(
      'Telegram session is not authorized. Run "npm run login" to generate a valid session.'
    );
  }

  const me = await client.getMe() as Api.User;
  clientLogger.info(
    { userId: me.id?.toString(), username: me.username },
    'Telegram connected'
  );

  clientInstance = client;
  return client;
}

/**
 * Resolves and validates all Telegram entities (sources, bot, destination)
 * on startup. Ensures the user account can access each one.
 *
 * Uses GramJS's getEntity() which handles various ID formats.
 * Channel IDs with -100 prefix are converted to big-integer for EntityLike compatibility.
 */
export async function resolveEntities(
  client: TelegramClient,
  config: Config,
  logger: Logger
): Promise<ResolvedEntities> {
  const entityLogger = logger.child({ module: 'EntityResolver' });

  entityLogger.info('Resolving Telegram entities...');

  // Resolve source channels
  const sourceChannels: Entity[] = [];
  for (const channelId of config.sourceChannelIds) {
    try {
      const sourceChannel = await client.getEntity(bigInt(channelId));
      const name = 'title' in sourceChannel ? (sourceChannel as Api.Channel).title : 'unknown';
      entityLogger.info(
        { id: channelId, name },
        'Source channel resolved'
      );
      sourceChannels.push(sourceChannel);
    } catch (err) {
      throw new Error(
        `Cannot resolve source channel ${channelId}. ` +
        'Ensure the user account is a member of this channel. ' +
        `Error: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  // Resolve processing bot
  // GramJS cannot resolve users by numeric ID without prior interaction.
  // Fallback: resolve by username via contacts.ResolveUsername API.
  let processingBot: Entity;
  try {
    processingBot = await client.getEntity(bigInt(config.processingBotId));
    const name = 'username' in processingBot ? (processingBot as Api.User).username : 'unknown';
    entityLogger.info(
      { id: config.processingBotId, name },
      'Processing bot resolved'
    );
  } catch {
    const botUsername = config.botUsername;
    entityLogger.info({ botUsername }, 'Bot not in cache — resolving by username...');
    try {
      const result = await client.invoke(
        new Api.contacts.ResolveUsername({ username: botUsername })
      );
      if (result.users && result.users.length > 0) {
        processingBot = result.users[0] as Entity;
        entityLogger.info(
          { id: config.processingBotId, username: botUsername },
          'Processing bot resolved via username'
        );
      } else {
        throw new Error('No users returned for username');
      }
    } catch (err) {
      throw new Error(
        `Cannot resolve processing bot @${botUsername} (ID: ${config.processingBotId}). ` +
        'Ensure the bot username is correct and the bot exists. ' +
        `Error: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  // Resolve destination channel
  let destinationChannel: Entity;
  try {
    destinationChannel = await client.getEntity(bigInt(config.destinationChannelId));
    const name = 'title' in destinationChannel ? (destinationChannel as Api.Channel).title : 'unknown';
    entityLogger.info(
      { id: config.destinationChannelId, name },
      'Destination channel resolved'
    );
  } catch (err) {
    throw new Error(
      `Cannot resolve destination channel ${config.destinationChannelId}. ` +
      'Ensure the user account is a member (with posting rights) of this channel. ' +
      `Error: ${err instanceof Error ? err.message : err}`
    );
  }

  entityLogger.info('All Telegram entities resolved successfully');
  return { sourceChannels, processingBot, destinationChannel };
}

/**
 * Returns the current TelegramClient instance.
 */
export function getClient(): TelegramClient {
  if (!clientInstance) {
    throw new Error('Telegram client not initialized. Call connectClient() first.');
  }
  return clientInstance;
}

/**
 * Gracefully disconnects the Telegram client.
 */
export async function disconnectClient(logger: Logger): Promise<void> {
  if (clientInstance) {
    logger.info('Disconnecting Telegram client...');
    await clientInstance.disconnect();
    clientInstance = null;
    logger.info('Telegram client disconnected');
  }
}
