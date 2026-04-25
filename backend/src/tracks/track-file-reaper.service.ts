import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Track } from './entities/track.entity';
import { StorageService } from '../storage/storage.service';

/**
 * Track File Reaper — compensating cleanup for two-phase persistence failures.
 *
 * Phase ordering for CREATE:
 *   1. Save file to storage (reversible — reaper can delete orphans)
 *   2. Save Track row to DB  (if this fails, reaper cleans up the orphaned file)
 *
 * Phase ordering for DELETE:
 *   1. Soft-delete DB row (record preserved with deletedAt + orphanedFilename)
 *   2. Delete file from storage (if this fails, reaper retries later)
 *
 * The reaper runs periodically and:
 *   - Deletes files whose uploads have no corresponding DB row
 *     (orphaned by a failed CREATE after file save).
 *   - Deletes files referenced by soft-deleted DB rows
 *     (orphaned by a failed storage delete).
 */
@Injectable()
export class TrackFileReaperService {
  private readonly logger = new Logger(TrackFileReaperService.name);

  /** Minimum age (ms) before an orphan is eligible for cleanup. Avoids racing live uploads. */
  private readonly orphanMinAgeMs = 5 * 60 * 1000; // 5 minutes

  constructor(
    @InjectRepository(Track)
    private readonly trackRepo: Repository<Track>,
    private readonly storageService: StorageService,
  ) {}

  /**
   * Attempt to delete an orphaned file that was written before a DB save failed.
   * Called inline from TracksService.create on error.
   */
  async cleanupOrphanedFile(filename: string): Promise<void> {
    try {
      await this.storageService.deleteFile(filename);
      this.logger.log(`[reaper] cleaned up orphaned file after failed DB save: ${filename}`);
    } catch (err) {
      this.logger.warn(
        `[reaper] could not immediately clean orphaned file "${filename}", will retry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Retry deleting files referenced by soft-deleted Track rows.
   * Called by a scheduler on a configurable interval.
   *
   * @returns number of files successfully reaped in this run.
   */
  async reapSoftDeletedFiles(): Promise<number> {
    const cutoff = new Date(Date.now() - this.orphanMinAgeMs);

    // Find soft-deleted rows that still have an undeleted file reference
    const orphaned = await this.trackRepo
      .createQueryBuilder('track')
      .withDeleted()
      .where('track.deletedAt IS NOT NULL')
      .andWhere('track.deletedAt < :cutoff', { cutoff })
      .andWhere('track.filename IS NOT NULL')
      .andWhere("track.filename != ''")
      .getMany();

    if (orphaned.length === 0) {
      return 0;
    }

    this.logger.log(`[reaper] found ${orphaned.length} soft-deleted track(s) with pending file cleanup`);

    let reaped = 0;
    for (const track of orphaned) {
      try {
        const info = await this.storageService.getFileInfo(track.filename!);
        if (info.exists) {
          await this.storageService.deleteFile(track.filename!);
          this.logger.log(`[reaper] deleted orphaned file for track ${track.id}: ${track.filename}`);
        }

        // Clear the filename so this row is not retried
        await this.trackRepo
          .createQueryBuilder()
          .update(Track)
          .set({ filename: null as unknown as string })
          .where('id = :id', { id: track.id })
          .withDeleted()
          .execute();

        reaped++;
      } catch (err) {
        this.logger.warn(
          `[reaper] failed to reap file for track ${track.id} ("${track.filename}"): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.logger.log(`[reaper] reaped ${reaped}/${orphaned.length} file(s)`);
    return reaped;
  }
}
