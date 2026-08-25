import { Api } from 'telegram/tl';

/**
 * Regex to find URLs in plain text.
 * Matches http:// and https:// URLs, stopping at whitespace and common delimiters.
 */
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;

/**
 * Trailing punctuation that should be stripped from extracted URLs.
 */
const TRAILING_PUNCTUATION = /[.,;:!?\)\]\}>'"]+$/;

/**
 * Extracts and deduplicates URLs from a Telegram message.
 *
 * Sources:
 * 1. Plain text via regex
 * 2. MessageEntityUrl entities (inline URLs)
 * 3. MessageEntityTextUrl entities (hyperlinked text)
 *
 * GramJS stores caption text and caption entities in the same `message.message`
 * and `message.entities` fields for media messages, so this covers captions too.
 */
export function extractUrls(message: Api.Message): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  const text = message.message || '';

  // 1. Extract URLs from plain text via regex
  if (text) {
    const matches = text.match(URL_REGEX);
    if (matches) {
      for (const raw of matches) {
        const normalized = normalizeUrl(raw);
        if (normalized && !seen.has(normalized)) {
          seen.add(normalized);
          results.push(normalized);
        }
      }
    }
  }

  // 2. Extract from Telegram message entities
  if (message.entities) {
    for (const entity of message.entities) {
      let rawUrl: string | null = null;

      if (entity.className === 'MessageEntityUrl') {
        // The URL is embedded directly in the text
        rawUrl = text.substring(entity.offset, entity.offset + entity.length);
      } else if (entity.className === 'MessageEntityTextUrl') {
        // The URL is in the entity's url property (hyperlink)
        rawUrl = (entity as Api.MessageEntityTextUrl).url;
      }

      if (rawUrl) {
        const normalized = normalizeUrl(rawUrl);
        if (normalized && !seen.has(normalized)) {
          seen.add(normalized);
          results.push(normalized);
        }
      }
    }
  }

  return results;
}

/**
 * Normalizes a URL:
 * - Strips trailing punctuation
 * - Lowercases hostname
 * - Removes URL fragment (#...)
 * - Preserves path and query parameters
 */
export function normalizeUrl(raw: string): string {
  // Strip trailing punctuation that often clings to URLs in messages
  let cleaned = raw.replace(TRAILING_PUNCTUATION, '');

  // Ensure the URL has a protocol
  if (!cleaned.startsWith('http://') && !cleaned.startsWith('https://')) {
    cleaned = 'https://' + cleaned;
  }

  try {
    const parsed = new URL(cleaned);
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = ''; // Remove fragment
    return parsed.toString();
  } catch {
    // If URL parsing fails, return the cleaned string lowercased
    return cleaned.toLowerCase();
  }
}
