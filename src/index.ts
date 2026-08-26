import { loadConfig } from './config';
import { createLogger } from './utils/logger';
import { ensureDirectories, cleanTempDir } from './utils/cleanup';
import { initDatabase, closeDatabase } from './database/database';
import { JobsRepository } from './database/jobsRepository';
import { connectClient, resolveEntities, disconnectClient } from './telegram/client';
import { startSourceMonitor, processHistoricalMessages } from './telegram/sourceMonitor';
import { startBotResponseListener } from './telegram/processingBot';
import { JobQueue } from './services/jobQueue';
import { StateManager } from './services/stateManager';
import path from 'path';
import http from 'http';

async function main(): Promise<void> {
  // ── 0. Start Dummy HTTP Server for Render Free Tier ─────────────────
  const port = process.env.PORT || 3000;
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Telegram TeraBox Automation is running!\n');
  }).listen(port, () => {
    console.log(`Dummy HTTP server listening on port ${port} for health checks.`);
  });

  // ── 1. Load config ──────────────────────────────────────────────────
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  logger.info('Starting Telegram TeraBox Automation');

  // ── 2. Ensure directories & clean temp ──────────────────────────────
  const dataDir = path.dirname(config.databasePath);
  ensureDirectories([dataDir, config.tempDir], logger);
  cleanTempDir(config.tempDir, logger);

  // ── 3. Initialize database ──────────────────────────────────────────
  const db = await initDatabase(config.databasePath, logger);
  const repo = new JobsRepository(db, logger);

  // ── 4. Connect Telegram (with delay for Render) ─────────────────────
  // Render uses Zero-Downtime deploys. The new instance starts while the old one
  // is still running. If both connect to Telegram simultaneously, Telegram revokes
  // the session (AUTH_KEY_DUPLICATED). We delay the connection by 15 seconds to
  // give Render time to kill the old instance.
  logger.info('Waiting 15 seconds for old instances to shut down...');
  await new Promise(resolve => setTimeout(resolve, 15000));
  const client = await connectClient(config, logger);

  // ── 5. Resolve entities ─────────────────────────────────────────────
  const entities = await resolveEntities(client, config, logger);

  // ── 5.5 Initialize State Manager ──────────────────────────────────────
  const stateManager = new StateManager(client, logger);
  await stateManager.loadState();
  stateManager.startAutoSave(60000);

  // ── 6. Initialize job queue ─────────────────────────────────────────
  const queue = new JobQueue(client, entities, repo, config, logger);

  // ── 7. Recover unfinished jobs from previous run ────────────────────
  queue.recoverJobs();

  // ── 8. Start bot response listener ──────────────────────────────────
  // This must start BEFORE the source monitor so we don't miss any bot
  // responses triggered by recovered jobs.
  startBotResponseListener(
    client,
    entities,
    (videoMessage) => {
      queue.onVideoReceived(videoMessage);
    },
    logger,
    (errorMessage) => {
      queue.onVideoError(errorMessage);
    }
  );

  // ── 9. Process historical messages (if configured) ──────────────────
  await processHistoricalMessages(
    client,
    entities,
    config.teraboxDomains,
    config.historyLimit,
    repo,
    stateManager,
    logger
  );

  // ── 10. Start source channel monitor ─────────────────────────────────
  await startSourceMonitor(
    client,
    entities,
    config.teraboxDomains,
    repo,
    stateManager,
    (jobId) => {
      queue.enqueue(jobId);
    },
    logger
  );

  // ── 11. Start the queue (processes recovered + new jobs) ────────────
  queue.start();

  logger.info('═══════════════════════════════════════════════════════════');
  logger.info('  Telegram TeraBox Automation is RUNNING');
  logger.info(`  Source channels:     ${config.sourceChannelIds.join(', ')}`);
  logger.info(`  Processing bot:      ${config.processingBotId}`);
  logger.info(`  Destination channel: ${config.destinationChannelId}`);
  logger.info(`  TeraBox domains:     ${[...config.teraboxDomains].join(', ')}`);
  logger.info(`  Video timeout:       ${config.videoTimeoutMinutes} min`);
  logger.info(`  Max retries:         ${config.maxRetries}`);
  logger.info('═══════════════════════════════════════════════════════════');

  // ── 12. Graceful shutdown ───────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    queue.stop();
    stateManager.stopAutoSave();
    await stateManager.forceSave();
    await disconnectClient(logger);
    closeDatabase(logger);
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep the process running
  process.on('unhandledRejection', (reason) => {
    // GramJS fires empty rejections for internal update processing — suppress noise
    if (!reason || (typeof reason === 'object' && Object.keys(reason as object).length === 0)) {
      logger.debug('Suppressed empty unhandled rejection (GramJS internal)');
      return;
    }
    logger.error({ reason }, 'Unhandled rejection');
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — shutting down');
    shutdown('uncaughtException').catch(() => process.exit(1));
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
