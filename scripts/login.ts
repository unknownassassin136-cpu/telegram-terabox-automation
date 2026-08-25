/**
 * First-run Telegram authentication script.
 *
 * Generates a StringSession that should be saved to the TELEGRAM_SESSION env var.
 *
 * Usage: npm run login
 *
 * Security:
 * - Never logs the session string to a file
 * - Never hard-codes credentials
 * - Never stores passwords or login codes
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import dotenv from 'dotenv';
import readline from 'readline';

dotenv.config();

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function login(): Promise<void> {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Telegram TeraBox Automation — First-Run Login');
  console.log('═══════════════════════════════════════════════════');
  console.log();

  // Check for API credentials
  const apiIdStr = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;

  if (!apiIdStr || !apiHash) {
    console.error('ERROR: TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in .env');
    console.error();
    console.error('Steps to get these:');
    console.error('  1. Go to https://my.telegram.org');
    console.error('  2. Log in with your phone number');
    console.error('  3. Go to "API development tools"');
    console.error('  4. Create an application (or use existing)');
    console.error('  5. Copy the api_id and api_hash to your .env file');
    console.error();
    console.error('Example .env:');
    console.error('  TELEGRAM_API_ID=12345678');
    console.error('  TELEGRAM_API_HASH=abcdef1234567890abcdef1234567890');
    process.exit(1);
  }

  const apiId = parseInt(apiIdStr, 10);
  if (isNaN(apiId)) {
    console.error('ERROR: TELEGRAM_API_ID must be a valid integer');
    process.exit(1);
  }

  // Create client with empty session
  const session = new StringSession('');
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  console.log('Connecting to Telegram...');

  await client.start({
    phoneNumber: async () => {
      return await prompt('Enter your phone number (with country code, e.g. +1234567890): ');
    },
    password: async () => {
      return await prompt('Enter your 2FA password (if enabled): ');
    },
    phoneCode: async () => {
      return await prompt('Enter the login code sent to your Telegram: ');
    },
    onError: (err) => {
      console.error('Authentication error:', err.message);
    },
  });

  console.log();
  console.log('✓ Successfully authenticated!');
  console.log();

  // Get the session string
  const sessionString = client.session.save() as unknown as string;

  console.log('═══════════════════════════════════════════════════');
  console.log('  YOUR SESSION STRING (copy this to .env):');
  console.log('═══════════════════════════════════════════════════');
  console.log();
  console.log(sessionString);
  console.log();
  console.log('═══════════════════════════════════════════════════');
  console.log();
  console.log('Add this to your .env file as:');
  console.log('  TELEGRAM_SESSION=<the string above>');
  console.log();
  console.log('⚠ SECURITY: Treat this session string like a password.');
  console.log('  - Never commit it to version control');
  console.log('  - Never share it with anyone');
  console.log('  - Never post it in public channels or forums');
  console.log();

  await client.disconnect();
  process.exit(0);
}

login().catch((err) => {
  console.error('Login failed:', err);
  process.exit(1);
});
