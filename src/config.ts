import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalEnv(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : defaultValue;
}

export interface Config {
  telegramApiId: number;
  telegramApiHash: string;
  telegramSession: string;
  sourceChannelId: string;
  processingBotId: string;
  botUsername: string;
  destinationChannelId: string;
  teraboxDomains: Set<string>;
  historyLimit: number;
  maxConcurrentJobs: number;
  videoTimeoutMinutes: number;
  maxRetries: number;
  tempDir: string;
  databasePath: string;
  logLevel: string;
}

export function loadConfig(): Config {
  const apiId = parseInt(requireEnv('TELEGRAM_API_ID'), 10);
  if (isNaN(apiId)) {
    throw new Error('TELEGRAM_API_ID must be a valid integer');
  }

  const domains = optionalEnv(
    'TERABOX_DOMAINS',
    'terabox.com,www.terabox.com,teraboxapp.com,www.teraboxapp.com'
  )
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);

  if (domains.length === 0) {
    throw new Error('TERABOX_DOMAINS must contain at least one domain');
  }

  const maxConcurrent = parseInt(optionalEnv('MAX_CONCURRENT_JOBS', '1'), 10);
  if (maxConcurrent !== 1) {
    console.warn(
      'WARNING: MAX_CONCURRENT_JOBS > 1 is not recommended. Auto-MD lacks request correlation. Forcing to 1.'
    );
  }

  return {
    telegramApiId: apiId,
    telegramApiHash: requireEnv('TELEGRAM_API_HASH'),
    telegramSession: requireEnv('TELEGRAM_SESSION'),
    sourceChannelId: requireEnv('SOURCE_CHANNEL_ID'),
    processingBotId: requireEnv('PROCESSING_BOT_ID'),
    botUsername: optionalEnv('BOT_USERNAME', 'Terabof5bot').replace(/^@/, ''),
    destinationChannelId: requireEnv('DESTINATION_CHANNEL_ID'),
    teraboxDomains: new Set(domains),
    historyLimit: parseInt(optionalEnv('HISTORY_LIMIT', '0'), 10),
    maxConcurrentJobs: 1, // Forced to 1 — serial processing only
    videoTimeoutMinutes: parseInt(optionalEnv('VIDEO_TIMEOUT_MINUTES', '15'), 10),
    maxRetries: parseInt(optionalEnv('MAX_RETRIES', '2'), 10),
    tempDir: path.resolve(optionalEnv('TEMP_DIR', './tmp')),
    databasePath: path.resolve(optionalEnv('DATABASE_PATH', './data/jobs.sqlite')),
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
  };
}
