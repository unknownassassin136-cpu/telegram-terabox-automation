import { TelegramClient } from 'telegram';
import { NewMessage } from 'telegram/events';
import { Api } from 'telegram/tl';
import { extractUrls } from '../services/urlExtractor';
import { filterTeraboxUrls } from '../services/teraboxFilter';
import { JobsRepository, CreateJobData } from '../database/jobsRepository';
import { Logger } from '../utils/logger';
import { ResolvedEntities } from './client';
import { StateManager } from '../services/stateManager';

/**
 * Starts monitoring the source channel for new messages containing TeraBox URLs.
 *
 * Design:
 * - Uses the user's Telegram account (MTProto) — no admin privileges required.
 * - Only processes messages arriving AFTER startup (not historical).
 * - Extracts URLs from text, entities, and media captions.
 * - Filters through the TeraBox domain allowlist.
 * - Creates a job for each unique TeraBox URL found.
 *
 * @param onJobCreated - Callback invoked when a new job is created, for queue scheduling.
 */
export async function startSourceMonitor(
  client: TelegramClient,
  entities: ResolvedEntities,
  teraboxDomains: Set<string>,
  repo: JobsRepository,
  stateManager: StateManager,
  onJobCreated: (jobId: number) => void,
  logger: Logger
): Promise<void> {
  const monitorLogger = logger.child({ module: 'SourceMonitor' });

  const sourceChannelIds = entities.sourceChannels.map(c => 'id' in c ? c.id.toString() : 'unknown');

  monitorLogger.info(
    { channelIds: sourceChannelIds },
    'Source monitor starting — utilizing State Manager for persistence'
  );

  const sourceEntities = entities.sourceChannels;

  // Register the event handler
  client.addEventHandler(
    async (event) => {
      try {
        const message = event.message as Api.Message;
        if (!message) return;

        const channelId = message.peerId ? message.peerId.toString() : 'unknown';

        // Guard: skip messages already processed or from before the bot knew about this channel's state
        if (!stateManager.shouldProcessMessage(channelId, message.id)) {
          monitorLogger.debug(
            { messageId: message.id, channelId },
            'Skipping already processed message'
          );
          return;
        }

        // Update the state manager with this new message ID
        stateManager.updateLastProcessedId(channelId, message.id);

        monitorLogger.info({ messageId: message.id, channelId }, 'New source message');

        // Extract all URLs from the message
        const allUrls = extractUrls(message);
        if (allUrls.length === 0) {
          monitorLogger.debug({ messageId: message.id }, 'No URLs in message');
          return;
        }

        monitorLogger.info(
          { messageId: message.id, urlCount: allUrls.length },
          'Found URLs in message'
        );

        // Filter for TeraBox URLs only
        const teraboxUrls = filterTeraboxUrls(allUrls, teraboxDomains, monitorLogger);
        if (teraboxUrls.length === 0) {
          monitorLogger.info({ messageId: message.id }, 'No TeraBox URLs found — ignoring message');
          return;
        }

        // Create a job for each unique TeraBox URL
        for (const url of teraboxUrls) {
          const jobData: CreateJobData = {
            sourceChatId: channelId,
            sourceMessageId: message.id,
            sourceUrl: url,
            normalizedUrl: url, // Already normalized by urlExtractor
          };

          const job = repo.createJob(jobData);
          if (job) {
            monitorLogger.info(
              { jobId: job.id, url, messageId: message.id },
              'Job created for TeraBox URL'
            );
            onJobCreated(job.id);
          }
          // If job is null, it's a duplicate — already logged by repo
        }
      } catch (err) {
        monitorLogger.error({ err }, 'Error processing source message');
      }
    },
    new NewMessage({ chats: sourceEntities })
  );

  monitorLogger.info(
    { channelIds: sourceChannelIds },
    'Source channels monitor active — listening for new messages'
  );
}

/**
 * Sweeps the source channel for historical messages containing TeraBox URLs.
 * Processes up to historyLimit messages. 
 */
export async function processHistoricalMessages(
  client: TelegramClient,
  entities: ResolvedEntities,
  teraboxDomains: Set<string>,
  historyLimit: number,
  repo: JobsRepository,
  stateManager: StateManager,
  logger: Logger
): Promise<void> {
  if (historyLimit <= 0) return;

  const historyLogger = logger.child({ module: 'HistoryProcessor' });
  const sourceChannelIds = entities.sourceChannels.map(c => 'id' in c ? c.id.toString() : 'unknown');
  
  historyLogger.info(
    { channelIds: sourceChannelIds, historyLimit },
    'Starting historical message sweep for all channels'
  );

  let totalProcessedCount = 0;
  let totalJobCount = 0;

  for (const sourceEntity of entities.sourceChannels) {
    const sourceChannelId = 'id' in sourceEntity ? sourceEntity.id.toString() : 'unknown';
    
    try {
      let processedCount = 0;
      let jobCount = 0;

      for await (const message of client.iterMessages(sourceEntity, {
        limit: historyLimit,
      })) {
        processedCount++;

        if (!message || !(message instanceof Api.Message)) continue;

        if (!stateManager.shouldProcessMessage(sourceChannelId, message.id)) {
          continue; // Skip messages we've already processed across restarts
        }

        // Update the highest seen ID so we don't process it again
        stateManager.updateLastProcessedId(sourceChannelId, message.id);

        const allUrls = extractUrls(message);
        if (allUrls.length === 0) continue;

        const teraboxUrls = filterTeraboxUrls(allUrls, teraboxDomains, historyLogger);
        if (teraboxUrls.length === 0) continue;

        for (const url of teraboxUrls) {
          const jobData: CreateJobData = {
            sourceChatId: sourceChannelId,
            sourceMessageId: message.id,
            sourceUrl: url,
            normalizedUrl: url,
          };

          // repo.createJob handles duplicate protection natively
          const job = repo.createJob(jobData);
          if (job) {
            jobCount++;
            historyLogger.info(
              { jobId: job.id, url, messageId: message.id, sourceChannelId },
              'Job created from historical message'
            );
          }
        }
      }

      totalProcessedCount += processedCount;
      totalJobCount += jobCount;
      historyLogger.info(
        { channelId: sourceChannelId, processedMessages: processedCount, newJobsCreated: jobCount },
        'Historical message sweep complete for channel'
      );
    } catch (err) {
      historyLogger.error({ err, channelId: sourceChannelId }, 'Error during historical message sweep');
    }
  }

  historyLogger.info(
    { totalProcessedMessages: totalProcessedCount, totalNewJobsCreated: totalJobCount },
    'All historical message sweeps complete'
  );

  // Force save the state after the sweep is complete
  await stateManager.forceSave();
}

