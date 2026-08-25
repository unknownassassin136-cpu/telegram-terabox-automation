import { Logger } from '../utils/logger';

/**
 * Filters a list of URLs, returning only those whose hostname matches the TeraBox domain allowlist.
 *
 * Uses proper URL hostname parsing — NOT substring matching.
 * `https://fake-terabox.com/...` will be correctly rejected.
 *
 * @param urls        - Array of normalized URLs to check
 * @param allowlist   - Set of allowed TeraBox hostnames (lowercased)
 * @param logger      - Logger instance for tracing accepted/ignored URLs
 * @returns           - Array of URLs that passed the TeraBox hostname check
 */
export function filterTeraboxUrls(
  urls: string[],
  allowlist: Set<string>,
  logger: Logger
): string[] {
  const accepted: string[] = [];

  for (const url of urls) {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();

      if (allowlist.has(hostname)) {
        accepted.push(url);
        logger.info({ url }, 'TeraBox URL accepted');
      } else {
        logger.info({ url, hostname }, 'Non-TeraBox URL ignored');
      }
    } catch {
      logger.warn({ url }, 'Invalid URL — ignored');
    }
  }

  return accepted;
}

/**
 * Standalone test for the TeraBox filter.
 * Run with: npx tsx src/services/teraboxFilter.ts
 */
if (require.main === module) {
  const testDomains = new Set([
    'terabox.com',
    'www.terabox.com',
    'teraboxapp.com',
    'www.teraboxapp.com',
  ]);

  const pino = require('pino');
  const testLogger = pino({ level: 'info', transport: { target: 'pino-pretty' } });

  const testUrls = [
    'https://terabox.com/s/example',
    'https://www.terabox.com/s/example',
    'https://teraboxapp.com/s/example',
    'https://example.com/ad',
    'https://instagram.com/example',
    'https://youtube.com/example',
    'https://fake-terabox.com/example',
  ];

  console.log('\n=== TeraBox Filter Test ===\n');
  const result = filterTeraboxUrls(testUrls, testDomains, testLogger);
  console.log('\nAccepted URLs:', result);
  console.log('Expected: 3 TeraBox URLs accepted, 4 rejected');
  console.log(`Result: ${result.length === 3 ? 'PASS ✓' : 'FAIL ✗'}`);
}
