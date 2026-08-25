import { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import { Config } from '../config';
import { Logger } from '../utils/logger';
import { JobsRepository, Job } from '../database/jobsRepository';
import { ResolvedEntities } from '../telegram/client';
import { sendUrlToBot } from '../telegram/processingBot';
import { uploadVideoToDestination } from '../telegram/destinationUploader';
import { downloadVideo, deleteTemp } from './mediaService';

/**
 * Serial job queue for the TeraBox → Auto-MD → Destination pipeline.
 *
 * Key design decisions:
 * - Only ONE job is active at any time (serial processing).
 * - Auto-MD lacks request correlation IDs, so serial processing ensures
 *   any video from the bot deterministically belongs to the current job.
 * - On timeout, the job is retried up to MAX_RETRIES, then marked FAILED.
 * - The queue automatically advances to the next job after completion/failure.
 *
 * State machine:
 *   DETECTED → QUEUED → SENT_TO_BOT → WAITING_FOR_VIDEO → VIDEO_RECEIVED → UPLOADING → COMPLETED
 *   WAITING_FOR_VIDEO → (timeout) → QUEUED (retry) or FAILED (max retries)
 */
export class JobQueue {
  private client: TelegramClient;
  private entities: ResolvedEntities;
  private repo: JobsRepository;
  private config: Config;
  private logger: Logger;

  /** The job currently being processed by Auto-MD. Null means the queue is idle. */
  private activeJob: Job | null = null;

  /** Timer for the current job's video timeout. */
  private timeoutTimer: NodeJS.Timeout | null = null;

  /** Periodic checker for timed-out jobs (backup for edge cases). */
  private checkInterval: NodeJS.Timeout | null = null;

  /** Flag to prevent concurrent processNext() calls. */
  private isAdvancing = false;

  constructor(
    client: TelegramClient,
    entities: ResolvedEntities,
    repo: JobsRepository,
    config: Config,
    logger: Logger
  ) {
    this.client = client;
    this.entities = entities;
    this.repo = repo;
    this.config = config;
    this.logger = logger.child({ module: 'JobQueue' });
  }

  /**
   * Starts the queue. Begins periodic timeout checks and attempts to process
   * any queued jobs (e.g. from a restart).
   */
  start(): void {
    // Periodic timeout check every 30 seconds (backup for timer edge cases)
    this.checkInterval = setInterval(() => this.checkTimeouts(), 30_000);
    this.logger.info('Job queue started');
    this.processNext();
  }

  /**
   * Stops the queue and clears all timers.
   */
  stop(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.logger.info('Job queue stopped');
  }

  /**
   * Returns the currently active job, or null if the queue is idle.
   * Used by the bot response listener to correlate incoming videos.
   */
  getActiveJob(): Job | null {
    return this.activeJob;
  }

  /**
   * Called when a new job is created by the source monitor.
   * Sets the job to QUEUED and attempts to advance the queue.
   */
  enqueue(jobId: number): void {
    const job = this.repo.getById(jobId);
    if (!job) return;

    this.repo.updateStatus(jobId, 'QUEUED');
    this.logger.info({ jobId }, 'Job queued');
    this.processNext();
  }

  /**
   * Attempts to pick the next queued job and start processing it.
   * No-op if a job is already active or no queued jobs exist.
   */
  async processNext(): Promise<void> {
    // Prevent re-entrant calls
    if (this.isAdvancing) return;
    if (this.activeJob) {
      this.logger.debug(
        { activeJobId: this.activeJob.id },
        'Queue busy — active job in progress'
      );
      return;
    }

    this.isAdvancing = true;

    try {
      const nextJob = this.repo.getNextQueued();
      if (!nextJob) {
        this.logger.debug('No queued jobs');
        return;
      }

      await this.startJob(nextJob);
    } catch (err) {
      this.logger.error({ err }, 'Error in processNext');
    } finally {
      this.isAdvancing = false;
    }
  }

  /**
   * Sends the URL to Auto-MD and starts the video timeout.
   */
  private async startJob(job: Job): Promise<void> {
    this.logger.info(
      { jobId: job.id, url: job.source_url, attempt: job.attempt_count + 1 },
      'Starting job — sending URL to Auto-MD'
    );

    try {
      // Increment attempt count
      this.repo.incrementAttempt(job.id);

      // Send URL to the bot
      const sentMsgId = await sendUrlToBot(
        this.client,
        this.entities,
        job.source_url,
        this.logger
      );

      // Update job status
      this.repo.setBotRequestMessageId(job.id, sentMsgId);
      this.repo.updateStatus(job.id, 'SENT_TO_BOT');
      this.repo.updateStatus(job.id, 'WAITING_FOR_VIDEO');

      // Set as active job (refresh from DB to get updated fields)
      this.activeJob = this.repo.getById(job.id) || null;

      // Start timeout timer
      this.startTimeout(job.id);

      this.logger.info(
        { jobId: job.id, timeoutMinutes: this.config.videoTimeoutMinutes },
        'Waiting for Auto-MD video response...'
      );
    } catch (err) {
      this.logger.error({ err, jobId: job.id }, 'Failed to send URL to Auto-MD');
      this.repo.setError(
        job.id,
        err instanceof Error ? err.message : String(err)
      );
      this.repo.updateStatus(job.id, 'FAILED');
      this.activeJob = null;

      // Try the next job
      setTimeout(() => this.processNext(), 2000);
    }
  }

  /**
   * Called by the bot response listener when a video arrives from Auto-MD.
   * Downloads the video and uploads it to the destination channel.
   */
  async onVideoReceived(videoMessage: Api.Message): Promise<void> {
    if (!this.activeJob) {
      this.logger.warn(
        { messageId: videoMessage.id },
        'Received video from bot but no active job — ignoring'
      );
      return;
    }

    const jobId = this.activeJob.id;

    // Clear the timeout timer
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }

    this.logger.info({ jobId, messageId: videoMessage.id }, 'Video received for job');

    // Update status
    this.repo.setVideoMessageId(jobId, videoMessage.id);
    this.repo.updateStatus(jobId, 'VIDEO_RECEIVED');

    let tempPath: string | null = null;

    try {
      // Download video
      this.repo.updateStatus(jobId, 'UPLOADING');
      tempPath = await downloadVideo(
        this.client,
        videoMessage,
        this.config.tempDir,
        this.logger
      );

      // Upload to destination channel
      const destMsgId = await uploadVideoToDestination(
        this.client,
        this.entities,
        tempPath,
        this.logger
      );

      // Mark completed
      this.repo.setDestinationMessageId(jobId, destMsgId);
      this.repo.updateStatus(jobId, 'COMPLETED');
      this.logger.info({ jobId, destinationMessageId: destMsgId }, 'Job COMPLETED');
    } catch (err) {
      this.logger.error({ err, jobId }, 'Failed during video download/upload');
      this.repo.setError(
        jobId,
        err instanceof Error ? err.message : String(err)
      );
      this.repo.updateStatus(jobId, 'FAILED');
    } finally {
      // Clean up temp file
      if (tempPath) {
        deleteTemp(tempPath, this.logger);
      }

      // Clear active job and advance the queue
      this.activeJob = null;
      setTimeout(() => this.processNext(), 2000);
    }
  }

  /**
   * Called by the bot response listener when the bot returns an error message for a URL.
   */
  onVideoError(errorMessage: string): void {
    if (!this.activeJob) {
      return;
    }

    const jobId = this.activeJob.id;
    this.logger.warn({ jobId, errorMessage }, 'Job failed due to bot error response');

    // Clear the timeout timer
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }

    // Mark as failed
    this.repo.setError(jobId, errorMessage);
    this.repo.updateStatus(jobId, 'FAILED');
    this.activeJob = null;

    // Process next job
    setTimeout(() => this.processNext(), 2000);
  }

  /**
   * Starts a timeout timer for the current job.
   */
  private startTimeout(jobId: number): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
    }

    const timeoutMs = this.config.videoTimeoutMinutes * 60 * 1000;
    this.timeoutTimer = setTimeout(() => {
      this.handleTimeout(jobId);
    }, timeoutMs);
  }

  /**
   * Handles a job timeout. Retries if under the limit, otherwise marks FAILED.
   */
  private handleTimeout(jobId: number): void {
    this.timeoutTimer = null;

    const job = this.repo.getById(jobId);
    if (!job) return;

    // Only handle timeout if this job is still the active one
    if (!this.activeJob || this.activeJob.id !== jobId) return;
    if (job.status !== 'WAITING_FOR_VIDEO') return;

    this.logger.warn(
      { jobId, attempts: job.attempt_count, maxRetries: this.config.maxRetries },
      'Job timed out waiting for video'
    );

    // Clear active job
    this.activeJob = null;

    if (job.attempt_count < this.config.maxRetries) {
      // Retry: re-queue the job
      this.logger.info({ jobId }, 'Re-queuing job for retry');
      this.repo.updateStatus(jobId, 'QUEUED');
    } else {
      // Max retries exhausted
      this.logger.error({ jobId }, 'Job FAILED — maximum retries exhausted');
      this.repo.setError(
        jobId,
        `Timed out after ${this.config.maxRetries} attempts (${this.config.videoTimeoutMinutes} min each)`
      );
      this.repo.updateStatus(jobId, 'FAILED');
    }

    // Advance the queue
    setTimeout(() => this.processNext(), 2000);
  }

  /**
   * Periodic check for timed-out jobs (backup for edge cases where
   * the primary setTimeout might not fire, e.g. after system sleep).
   */
  private checkTimeouts(): void {
    const timedOut = this.repo.getTimedOutJobs(this.config.videoTimeoutMinutes);
    for (const job of timedOut) {
      if (this.activeJob && this.activeJob.id === job.id) {
        this.handleTimeout(job.id);
      }
    }
  }

  /**
   * Handles recovery on restart.
   *
   * Recovery policy:
   * - COMPLETED jobs: skip (already uploaded).
   * - FAILED jobs: skip (already exhausted retries).
   * - QUEUED/DETECTED jobs: re-queue normally.
   * - SENT_TO_BOT/WAITING_FOR_VIDEO: these were mid-flight when the app crashed.
   *   If the job is still reasonably fresh (within timeout window), we re-queue
   *   it for a fresh attempt. We don't try to listen for a stale video response
   *   because the bot may have already sent it (and we missed it) or timed out.
   * - VIDEO_RECEIVED/UPLOADING: these crashed during download/upload.
   *   Re-queue for a fresh attempt.
   */
  recoverJobs(): void {
    this.logger.info('Recovering unfinished jobs from database...');

    // Recover SENT_TO_BOT / WAITING_FOR_VIDEO jobs (crashed mid-processing)
    const pendingJobs = this.repo.getPendingJobs();
    for (const job of pendingJobs) {
      this.logger.info(
        { jobId: job.id, status: job.status, url: job.source_url },
        'Recovering pending job → re-queuing'
      );
      this.repo.updateStatus(job.id, 'QUEUED');
    }

    // Recover VIDEO_RECEIVED / UPLOADING jobs (crashed mid-transfer)
    const staleJobs = this.repo.getStaleTransferJobs();
    for (const job of staleJobs) {
      this.logger.info(
        { jobId: job.id, status: job.status, url: job.source_url },
        'Recovering stale transfer job → re-queuing'
      );
      this.repo.updateStatus(job.id, 'QUEUED');
    }

    const hasQueued = !!this.repo.getNextQueued();
    this.logger.info(
      {
        pendingRecovered: pendingJobs.length,
        staleRecovered: staleJobs.length,
        hasQueuedJobs: hasQueued,
      },
      'Job recovery complete'
    );
  }
}
