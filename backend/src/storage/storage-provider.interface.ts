/**
 * Abstract storage provider interface.
 *
 * All storage backends (local filesystem, S3, GCS, etc.) implement this
 * contract so that higher-level modules (TracksService, etc.) never depend
 * on local-filesystem specifics.
 */
export interface StorageFileResult {
  /** Storage-unique identifier (filename, object key, etc.). */
  filename: string;
  /** Absolute path or remote URI (implementation-defined). */
  path: string;
  /** Public or pre-signed URL for client-side access. */
  url: string;
}

export interface StorageFileInfo {
  exists: boolean;
  size?: number;
  mimeType?: string;
}

export interface IStorageProvider {
  /**
   * Validate the file before persistence.
   * Throws BadRequestException on any constraint violation.
   */
  validateFile(file: Express.Multer.File): Promise<void>;

  /**
   * Persist the file and return stable references.
   * Implementations must be atomic: either the file is fully written or
   * nothing is written and an error is thrown.
   */
  saveFile(file: Express.Multer.File): Promise<StorageFileResult>;

  /**
   * Remove the file identified by `filename`.
   * Implementations should be idempotent: a missing file should not throw.
   */
  deleteFile(filename: string): Promise<void>;

  /** Return metadata for an existing file. */
  getFileInfo(filename: string): Promise<StorageFileInfo>;

  /** Return a URL suitable for streaming/downloading. */
  getStreamingUrl(filename: string): Promise<string>;

  /** Derive a unique storage key from an original filename. */
  generateUniqueFileName(originalName: string): string;

  /** Resolve the full path or URI for direct backend access. */
  getFilePath(filename: string): string;
}

/** Injection token for the active storage provider. */
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
