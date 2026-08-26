import { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import { Logger } from '../utils/logger';

interface BotState {
  lastProcessedIds: Record<string, number>;
}

/**
 * Manages the bot's state by saving it to the user's "Saved Messages" chat.
 * This makes the state persistent across Render restarts without needing an external database.
 */
export class StateManager {
  private client: TelegramClient;
  private logger: Logger;
  private state: BotState = { lastProcessedIds: {} };
  private stateMessageId: number | null = null;
  private isDirty: boolean = false;
  private autoSaveInterval: NodeJS.Timeout | null = null;

  private static readonly STATE_PREFIX = '#TeraboxBotState\n\n';

  constructor(client: TelegramClient, logger: Logger) {
    this.client = client;
    this.logger = logger.child({ module: 'StateManager' });
  }

  /**
   * Loads the state from Saved Messages, or creates a new one if it doesn't exist.
   */
  public async loadState(): Promise<void> {
    this.logger.info('Searching for state in Saved Messages...');
    try {
      const messages = await this.client.getMessages('me', {
        search: '#TeraboxBotState',
        limit: 1,
      });

      if (messages.length > 0 && messages[0].message) {
        this.stateMessageId = messages[0].id;
        const text = messages[0].message.replace(StateManager.STATE_PREFIX, '');
        try {
          this.state = JSON.parse(text);
          this.logger.info({ state: this.state }, 'State loaded successfully');
        } catch (parseErr) {
          this.logger.error({ err: parseErr }, 'Failed to parse state JSON. Resetting state.');
          this.state = { lastProcessedIds: {} };
          this.isDirty = true;
        }
      } else {
        this.logger.info('No existing state found. Creating a new one.');
        this.state = { lastProcessedIds: {} };
        await this.forceSave();
      }
    } catch (err) {
      this.logger.error({ err }, 'Error loading state from Saved Messages');
    }
  }

  /**
   * Updates the highest processed message ID for a given channel.
   * Only updates if the new ID is strictly greater than the existing one.
   */
  public updateLastProcessedId(channelId: string, messageId: number): void {
    const currentMax = this.state.lastProcessedIds[channelId] || 0;
    if (messageId > currentMax) {
      this.state.lastProcessedIds[channelId] = messageId;
      this.isDirty = true;
    }
  }

  /**
   * Checks if a message should be processed based on its ID.
   */
  public shouldProcessMessage(channelId: string, messageId: number): boolean {
    const lastProcessedId = this.state.lastProcessedIds[channelId] || 0;
    return messageId > lastProcessedId;
  }

  /**
   * Immediately saves the state to Saved Messages if it is dirty.
   */
  public async forceSave(): Promise<void> {
    if (!this.isDirty && this.stateMessageId !== null) return;

    const jsonStr = JSON.stringify(this.state, null, 2);
    const fullText = StateManager.STATE_PREFIX + jsonStr;

    try {
      if (this.stateMessageId !== null) {
        await this.client.editMessage('me', {
          message: this.stateMessageId,
          text: fullText,
        });
      } else {
        const msg = await this.client.sendMessage('me', { message: fullText });
        this.stateMessageId = msg.id;
      }
      this.isDirty = false;
      this.logger.info('State successfully saved to Saved Messages');
    } catch (err) {
      this.logger.error({ err }, 'Failed to save state to Saved Messages');
    }
  }

  /**
   * Starts an interval that periodically saves the state if it has changed.
   */
  public startAutoSave(intervalMs: number = 60000): void {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }
    
    this.logger.info(`Starting auto-save interval (${intervalMs}ms)`);
    this.autoSaveInterval = setInterval(() => {
      if (this.isDirty) {
        this.forceSave().catch(err => this.logger.error({ err }, 'Auto-save failed'));
      }
    }, intervalMs);
  }

  public stopAutoSave(): void {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
    }
  }
}
