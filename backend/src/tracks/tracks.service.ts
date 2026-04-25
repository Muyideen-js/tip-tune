import {
  Injectable,
  NotFoundException,
  Logger,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { PaginatedResponse } from "../common/dto/paginated-response.dto";
import { paginate } from "../common/helpers/paginate.helper";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Track } from "./entities/track.entity";
import { CreateTrackDto } from "./dto/create-track.dto";
import { TrackFilterDto } from "./dto/pagination.dto";
import { StorageService } from "../storage/storage.service";
import { ActivitiesService } from "../activities/activities.service";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { TrackUploadedEvent } from "./events/track-uploaded.event";
import { LicensingService } from "@/track-listening-right-management/licensing.service";
import { PaginatedResult } from "@/events-live-show/events.service";
import { ResourceNotFoundException } from "../common/exceptions/api-exception";
import { PlayCountService } from "../track-play-count/play-count.service";
import { TrackFileReaperService } from "./track-file-reaper.service";

@Injectable()
export class TracksService {
  private readonly logger = new Logger(TracksService.name);

  constructor(
    @InjectRepository(Track)
    private tracksRepository: Repository<Track>,
    private storageService: StorageService,
    @Inject(forwardRef(() => ActivitiesService))
    private activitiesService: ActivitiesService,
    private eventEmitter: EventEmitter2,
    private licensingService: LicensingService,
    private playCountService: PlayCountService,
    private readonly reaperService: TrackFileReaperService,
  ) {}

  async create(
    createTrackDto: CreateTrackDto,
    file?: Express.Multer.File,
  ): Promise<Track> {
    try {
      let audioUrl = createTrackDto.audioUrl;
      let filename: string;
      let url: string;
      let streamingUrl: string;
      let fileSize: bigint;
      let mimeType: string;

      if (file) {
        // Phase 1: persist the file to storage.
        // If Phase 2 (DB save) fails below, the reaper will delete this file.
        const fileResult = await this.storageService.saveFile(file);
        const fileInfo = await this.storageService.getFileInfo(
          fileResult.filename,
        );

        filename = fileResult.filename;
        url = fileResult.url;
        streamingUrl = await this.storageService.getStreamingUrl(
          fileResult.filename,
        );
        fileSize = BigInt(fileInfo.size);
        mimeType = fileInfo.mimeType;
        audioUrl = url;
      }

      // Phase 2: persist the DB record.
      // If this fails and a file was written in Phase 1, compensate immediately.
      const track = this.tracksRepository.create({
        ...createTrackDto,
        audioUrl,
        filename,
        url,
        streamingUrl,
        fileSize,
        mimeType,
      });

      let savedTrack: Track;
      try {
        savedTrack = await this.tracksRepository.save(track);
      } catch (dbError) {
        // Compensating action: remove the orphaned file we wrote in Phase 1.
        if (filename) {
          await this.reaperService.cleanupOrphanedFile(filename);
        }
        throw dbError;
      }
      this.logger.log(`Track created successfully: ${savedTrack.id}`);

      try {
        await this.licensingService.assignDefaultLicense(savedTrack.id);
        this.logger.log(`Default license assigned to track: ${savedTrack.id}`);
      } catch (error) {
        this.logger.warn(`Failed to assign default license: ${error.message}`);
      }

      if (savedTrack.artistId) {
        this.eventEmitter.emit(
          "track.uploaded",
          new TrackUploadedEvent(savedTrack.id, savedTrack.artistId),
        );
      }

      // Track activity for new track
      if (savedTrack.artistId) {
        try {
          await this.activitiesService.trackNewTrack(
            savedTrack.artistId,
            savedTrack.id,
            {
              trackTitle: savedTrack.title,
              genre: savedTrack.genre,
              album: savedTrack.album,
            },
          );
        } catch (error) {
          // Log but don't fail track creation if activity tracking fails
          this.logger.warn(
            `Failed to track activity for new track: ${error.message}`,
          );
        }
      }

      return savedTrack;
    } catch (error) {
      this.logger.error(`Failed to create track: ${error.message}`);
      throw error;
    }
  }

  async findAll(filter: TrackFilterDto): Promise<PaginatedResult<Track>> {
    const {
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      sortOrder = "DESC",
      ...filters
    } = filter;
    const skip = (page - 1) * limit;

    const queryBuilder = this.tracksRepository
      .createQueryBuilder("track")
      .leftJoinAndSelect("track.artist", "artist")
      .orderBy(`track.${sortBy}`, sortOrder)
      .skip(skip)
      .take(limit);

    // Apply filters
    if (filters.artistId) {
      queryBuilder.andWhere("track.artistId = :artistId", {
        artistId: filters.artistId,
      });
    }
    if (filters.genre) {
      queryBuilder.andWhere("track.genre = :genre", { genre: filters.genre });
    }
    if (filters.album) {
      queryBuilder.andWhere("track.album ILIKE :album", {
        album: `%${filters.album}%`,
      });
    }
    if (filters.isPublic !== undefined) {
      queryBuilder.andWhere("track.isPublic = :isPublic", {
        isPublic: filters.isPublic,
      });
    }
    if (filters.releaseDate) {
      queryBuilder.andWhere("track.releaseDate = :releaseDate", {
        releaseDate: filters.releaseDate,
      });
    }

    const [data, total] = await queryBuilder.getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findPublic(filter: TrackFilterDto): Promise<PaginatedResult<Track>> {
    return this.findAll({ ...filter, isPublic: true });
  }

  async findOne(id: string): Promise<Track> {
    const track = await this.tracksRepository.findOne({
      where: { id },
      relations: ["artist", "license"],
    });

    if (!track) {
      throw new ResourceNotFoundException("Track", id);
    }

    return track;
  }

  async update(
    id: string,
    updateTrackDto: Partial<CreateTrackDto>,
  ): Promise<Track> {
    const track = await this.findOne(id);

    Object.assign(track, updateTrackDto);

    const updatedTrack = await this.tracksRepository.save(track);
    this.logger.log(`Track updated successfully: ${id}`);

    return updatedTrack;
  }

  async remove(id: string): Promise<void> {
    const track = await this.findOne(id);

    try {
      // Phase 1: soft-delete the DB row first so the record is preserved
      // even if storage deletion fails.  The reaper will retry the file
      // deletion asynchronously using track.filename.
      await this.tracksRepository.softDelete(id);
      this.logger.log(`Track soft-deleted: ${id}`);

      // Phase 2: attempt immediate file deletion.
      // If it fails, the reaper will clean it up from the soft-deleted row.
      if (track.filename) {
        try {
          await this.storageService.deleteFile(track.filename);
          // Clear filename so the reaper skips it on the next run
          await this.tracksRepository
            .createQueryBuilder()
            .update(Track)
            .set({ filename: null as unknown as string })
            .where('id = :id', { id })
            .withDeleted()
            .execute();
        } catch (storageErr) {
          this.logger.warn(
            `Storage delete failed for track ${id} — reaper will retry: ${storageErr instanceof Error ? storageErr.message : String(storageErr)}`,
          );
        }
      }

      this.logger.log(`Track deleted successfully: ${id}`);
    } catch (error) {
      this.logger.error(`Failed to delete track: ${error.message}`);
      throw error;
    }
  }

  async incrementPlayCount(id: string): Promise<Track> {
    this.logger.warn(
      `Legacy track play endpoint invoked for ${id}; syncing aggregate from canonical play events`,
    );

    return this.playCountService.rebuildTrackPlayTotal(id);
  }

  async addTips(id: string, amount: number): Promise<Track> {
    const track = await this.findOne(id);

    track.totalTips += amount;

    const updatedTrack = await this.tracksRepository.save(track);

    return updatedTrack;
  }

  async findByArtist(
    artistId: string,
    filter: TrackFilterDto,
  ): Promise<PaginatedResult<Track>> {
    return this.findAll({ ...filter, artistId });
  }

  async findByGenre(
    genre: string,
    filter: TrackFilterDto,
  ): Promise<PaginatedResult<Track>> {
    return this.findAll({ ...filter, genre });
  }

  async search(
    query: string,
    filter: TrackFilterDto,
  ): Promise<PaginatedResult<Track>> {
    const {
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      sortOrder = "DESC",
    } = filter;
    const skip = (page - 1) * limit;

    const queryBuilder = this.tracksRepository
      .createQueryBuilder("track")
      .leftJoinAndSelect("track.artist", "artist")
      .where("track.title ILIKE :query", { query: `%${query}%` })
      .orWhere("track.album ILIKE :query", { query: `%${query}%` })
      .orderBy(`track.${sortBy}`, sortOrder)
      .skip(skip)
      .take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}
