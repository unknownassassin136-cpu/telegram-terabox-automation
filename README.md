# Telegram TeraBox Automation

Automated Telegram pipeline:  
**Source Channel → Auto-MD Bot → Clean Video → Destination Channel**

Monitors a Telegram channel for TeraBox links, sends them to the Auto-MD bot for video generation, and uploads the resulting videos to a destination channel as clean, caption-free messages.

---

## Features

- **MTProto/GramJS** — Uses the user's Telegram account, no bot required for reading
- **TeraBox-only filtering** — Only processes URLs from configured TeraBox domains
- **Serial processing** — One job at a time for reliable Auto-MD correlation
- **Clean uploads** — No forwarded-from, no bot captions, no metadata
- **SQLite job tracking** — Persistent state, duplicate protection, restart recovery
- **Timeout & retry** — Configurable timeout per job with automatic retry
- **Structured logging** — Pino logger with sensitive data redaction

---

## Prerequisites

- **Node.js** 18+ 
- **npm** 8+
- **Telegram account** — Must be a member of the source channel and destination channel
- **Telegram API credentials** — From [my.telegram.org](https://my.telegram.org)

---

## Setup

### 1. Get Telegram API Credentials

1. Go to [https://my.telegram.org](https://my.telegram.org)
2. Log in with your phone number
3. Click **"API development tools"**
4. Create an application (any name/description works)
5. Note the **api_id** (integer) and **api_hash** (hex string)

### 2. Configure Environment

```bash
# Copy the template
cp .env.example .env

# Edit .env and fill in your API credentials
# TELEGRAM_API_ID=12345678
# TELEGRAM_API_HASH=abcdef1234567890abcdef1234567890
```

### 3. Install Dependencies

```bash
npm install
```

### 4. First-Time Telegram Login

```bash
npm run login
```

This will:
1. Ask for your **phone number** (with country code, e.g. `+919876543210`)
2. Ask for the **login code** sent to your Telegram app
3. Ask for your **2FA password** (if enabled)
4. Output a **StringSession** — copy it to your `.env` file:

```env
TELEGRAM_SESSION=<paste the session string here>
```

> ⚠️ **Security**: The session string grants full access to your Telegram account. Never share it, commit it to git, or post it publicly.

### 5. Start the Automation

```bash
# Development (with TypeScript auto-compilation)
npm run dev

# OR Production (compile first, then run)
npm run build
npm start
```

---

## Configuration

All settings are in `.env`:

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_API_ID` | *(required)* | Telegram API ID from my.telegram.org |
| `TELEGRAM_API_HASH` | *(required)* | Telegram API hash from my.telegram.org |
| `TELEGRAM_SESSION` | *(required)* | StringSession from `npm run login` |
| `SOURCE_CHANNEL_ID` | `-1003574098343` | Telegram ID of the source channel to monitor |
| `PROCESSING_BOT_ID` | `8308228789` | Telegram user ID of the Auto-MD bot |
| `DESTINATION_CHANNEL_ID` | `-1003897175553` | Telegram ID of the destination channel |
| `TERABOX_DOMAINS` | `terabox.com,www.terabox.com,...` | Comma-separated TeraBox domain allowlist |
| `MAX_CONCURRENT_JOBS` | `1` | Must be 1 (serial processing) |
| `VIDEO_TIMEOUT_MINUTES` | `15` | Minutes to wait for Auto-MD response |
| `MAX_RETRIES` | `2` | Maximum retry attempts per failed job |
| `TEMP_DIR` | `./tmp` | Temporary directory for video downloads |
| `DATABASE_PATH` | `./data/jobs.sqlite` | SQLite database file path |
| `LOG_LEVEL` | `info` | Logging level (trace/debug/info/warn/error/fatal) |

---

## NPM Scripts

| Script | Command | Description |
|---|---|---|
| `npm run login` | `tsx scripts/login.ts` | Interactive Telegram authentication |
| `npm run dev` | `tsx src/index.ts` | Run in development mode (direct TypeScript) |
| `npm run build` | `tsc` | Compile TypeScript to JavaScript |
| `npm start` | `node dist/index.js` | Run compiled production build |

---

## How It Works

### Workflow

```
Source Channel (-1003574098343)
        │
        │  New message arrives
        ▼
  URL Extraction  ──→  Extract all URLs from text + entities + captions
        │
        ▼
  TeraBox Filter  ──→  Keep only URLs matching configured TeraBox domains
        │               Reject ads, Instagram, YouTube, etc.
        ▼
  Job Queue (SQLite) ──→  Create job, check for duplicates
        │
        ▼
  Auto-MD Bot (8308228789) ──→  Send only the URL (no caption, no commands)
        │
        │  Wait for video response (up to 15 min)
        │  Ignore "Analyzing..." and progress messages
        ▼
  Video Detection ──→  Accept video/* MIME or VideoAttribute documents
        │
        ▼
  Download ──→  Save to temp file (no re-encoding)
        │
        ▼
  Destination Upload (-1003897175553) ──→  sendFile() with empty caption
        │                                   NOT forwardMessages()
        ▼
  Clean Video ──→  No forwarded-from, no bot metadata, no caption
```

### Serial Processing

Only **one job** is sent to Auto-MD at a time. This is mandatory because the bot doesn't provide request correlation IDs. The queue processes jobs in FIFO order:

```
Job A → processing (sent to bot, waiting for video)
Job B → queued
Job C → queued

When A completes:
Job B → processing
Job C → queued
```

### State Machine

```
DETECTED → QUEUED → SENT_TO_BOT → WAITING_FOR_VIDEO → VIDEO_RECEIVED → UPLOADING → COMPLETED
                                         │
                                    (timeout)
                                         │
                                    QUEUED (retry)
                                      or
                                    FAILED (max retries)
```

---

## Testing

### Test TeraBox URL Filter

```bash
npx tsx src/services/teraboxFilter.ts
```

Expected output:
- ✓ `https://terabox.com/s/example` — accepted
- ✓ `https://www.terabox.com/s/example` — accepted
- ✓ `https://teraboxapp.com/s/example` — accepted
- ✗ `https://example.com/ad` — ignored
- ✗ `https://instagram.com/example` — ignored
- ✗ `https://youtube.com/example` — ignored
- ✗ `https://fake-terabox.com/example` — rejected (hostname doesn't match)

### Test with One TeraBox URL

1. Start the app: `npm run dev`
2. Post a message in the source channel containing a TeraBox URL
3. Watch the logs for the full pipeline:
   ```
   [INFO] New source message: 1234
   [INFO] TeraBox URL accepted: https://terabox.com/s/...
   [INFO] Job created: #1
   [INFO] Sending URL to Auto-MD
   [INFO] Waiting for Auto-MD video response...
   [INFO] Video received for job #1
   [INFO] Uploading video to destination...
   [INFO] Job #1 COMPLETED
   ```

### Check SQLite Job Status

```bash
# Using sqlite3 CLI
sqlite3 data/jobs.sqlite "SELECT id, status, source_url, created_at FROM jobs;"

# Or with full details
sqlite3 data/jobs.sqlite "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 10;"
```

---

## Troubleshooting

### "Cannot resolve source channel"
- Ensure your Telegram account is a member of the source channel
- Verify `SOURCE_CHANNEL_ID` is correct (including the `-100` prefix)

### "Cannot resolve destination channel"
- Ensure your Telegram account can post to the destination channel
- Verify `DESTINATION_CHANNEL_ID` is correct

### "Telegram session is not authorized"
- Run `npm run login` to generate a new session
- Copy the new session string to `.env`

### Auto-MD not responding
- Verify `PROCESSING_BOT_ID` is correct (`8308228789`)
- Try sending a TeraBox URL manually to the bot in Telegram
- Check that the bot is not rate-limiting you
- Increase `VIDEO_TIMEOUT_MINUTES` if the bot is slow

### Videos not appearing in destination
- Check that your account has posting rights in the destination channel
- Look for `UPLOADING` status in SQLite — the upload may have failed
- Check logs for error messages

### Duplicate jobs not being created
- This is by design — the same normalized URL creates only one job
- To reprocess a URL, delete its row from the `jobs` table

---

## Project Structure

```
telegram-terabox-automation/
├── src/
│   ├── index.ts                    # Main entry point
│   ├── config.ts                   # Environment config loader
│   ├── telegram/
│   │   ├── client.ts               # GramJS client + entity resolution
│   │   ├── sourceMonitor.ts        # Source channel listener
│   │   ├── processingBot.ts        # Auto-MD bot interaction
│   │   └── destinationUploader.ts  # Clean video upload
│   ├── services/
│   │   ├── urlExtractor.ts         # URL extraction from messages
│   │   ├── teraboxFilter.ts        # TeraBox domain allowlist
│   │   ├── jobQueue.ts             # Serial processing queue
│   │   └── mediaService.ts         # Video download/cleanup
│   ├── database/
│   │   ├── database.ts             # SQLite init + schema
│   │   └── jobsRepository.ts       # Job CRUD operations
│   └── utils/
│       ├── logger.ts               # Pino structured logger
│       └── cleanup.ts              # Temp file cleanup
├── scripts/
│   └── login.ts                    # First-run authentication
├── data/                           # SQLite database (gitignored)
├── tmp/                            # Temporary video files (gitignored)
├── .env.example                    # Environment template
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Security Notes

- **Session string**: Grants full access to your Telegram account. Treat it like a password.
- **Never commit** `.env` or session strings to version control.
- **The app only reads** messages your account is authorized to see — no access control bypasses.
- **Credentials** are loaded from environment variables, never hard-coded.
- **Sensitive data** (sessions, passwords) is redacted from log output.

---

## License

Private use. The application processes URLs and media the user is authorized to redistribute.
