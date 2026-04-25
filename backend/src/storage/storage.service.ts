import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { IStorageProvider, StorageFileResult, StorageFileInfo } from './storage-provider.interface';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as mime from 'mime-types';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';

/** Rejection reason codes returned to clients. */
export enum UploadRejectionCode {
  INVALID_MIME_TYPE = 'INVALID_MIME_TYPE',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  EXTENSION_MISMATCH = 'EXTENSION_MISMATCH',
  SUSPICIOUS_CONTENT = 'SUSPICIOUS_CONTENT',
  EMPTY_FILE = 'EMPTY_FILE',
  FILENAME_INVALID = 'FILENAME_INVALID',
}

/**
 * Magic-byte signatures for allowed audio formats.
 * Used to verify that the file content matches the declared MIME type.
 */
const MAGIC_BYTES: Record<string, { offset: number; bytes: number[] }[]> = {
  'audio/mpeg': [
    { offset: 0, bytes: [0xff, 0xfb] }, // MP3 frame sync
    { offset: 0, bytes: [0xff, 0xf3] }, // MP3 frame sync (MPEG 2.5)
    { offset: 0, bytes: [0xff, 0xf2] }, // MP3 frame sync
    { offset: 0, bytes: [0x49, 0x44, 0x33] }, // ID3 tag header
  ],
  'audio/wav': [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
  ],
  'audio/flac': [
    { offset: 0, bytes: [0x66, 0x4c, 0x61, 0x43] }, // fLaC
  ],
  'audio/x-flac': [
    { offset: 0, bytes: [0x66, 0x4c, 0x61, 0x43] }, // fLaC
  ],
};

/** Map from MIME type to valid file extensions. */
const MIME_TO_EXTENSIONS: Record<string, string[]> = {
  'audio/mpeg': ['.mp3'],
  'audio/wav': ['.wav'],
  'audio/flac': ['.flac'],
  'audio/x-flac': ['.flac'],
};

@Injectable()
export class StorageService implements IStorageProvider {
  private readonly logger = new Logger(StorageService.name);
  private readonly allowedMimeTypes = [
    'audio/mpeg',
    'audio/wav',
    'audio/flac',
    'audio/x-flac',
  ];
  private readonly maxFileSize: number;
  private readonly uploadDir: string;

  constructor(private configService: ConfigService) {
    this.maxFileSize =
      parseInt(this.configService.get<string>('MAX_FILE_SIZE')) ||
      50 * 1024 * 1024; // 50MB default
    this.uploadDir =
      this.configService.get<string>('UPLOAD_DIR') || './uploads';
    this.ensureUploadDirectory();
  }

  private async ensureUploadDirectory(): Promise<void> {
    try {
      await fs.access(this.uploadDir);
    } catch {
      await fs.mkdir(this.uploadDir, { recursive: true });
      this.logger.log(`Created upload directory: ${this.uploadDir}`);
    }
  }

  /**
   * Comprehensive file validation pipeline.
   * Checks: empty file, MIME whitelist, size limit, extension match, magic bytes,
   * filename security, and content sniffing.
   */
  async validateFile(file: Express.Multer.File): Promise<void> {
    // Reject empty files
    if (!file.buffer || file.size === 0) {
      throw new BadRequestException({
        code: UploadRejectionCode.EMPTY_FILE,
        message: 'File is empty',
      });
    }

    // Reject invalid filenames (path traversal, null bytes, special chars)
    if (
      !file.originalname ||
      file.originalname.includes('\0') ||
      file.originalname.includes('..') ||
      /[<>:"|?*]/.test(file.originalname) ||
      file.originalname.trim() !== file.originalname ||
      file.originalname.length > 255
    ) {
      throw new BadRequestException({
        code: UploadRejectionCode.FILENAME_INVALID,
        message: 'Filename contains invalid characters or is too long',
      });
    }

    // Normalize and sanitize filename
    const sanitizedName = this.sanitizeFilename(file.originalname);
    if (!sanitizedName || sanitizedName.length === 0) {
      throw new BadRequestException({
        code: UploadRejectionCode.FILENAME_INVALID,
        message: 'Invalid filename after sanitization',
      });
    }

    // MIME type whitelist
    if (!this.allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException({
        code: UploadRejectionCode.INVALID_MIME_TYPE,
        message: `Invalid file type "${file.mimetype}". Allowed: ${this.allowedMimeTypes.join(', ')}`,
      });
    }

    // File size limit with stricter check
    if (file.size <= 0 || file.size > this.maxFileSize) {
      throw new BadRequestException({
        code: UploadRejectionCode.FILE_TOO_LARGE,
        message: `File size ${(file.size / (1024 * 1024)).toFixed(1)}MB exceeds limit of ${(this.maxFileSize / (1024 * 1024)).toFixed(0)}MB`,
      });
    }

    // Extension must match declared MIME type
    const ext = path.extname(sanitizedName).toLowerCase();
    const allowedExts = MIME_TO_EXTENSIONS[file.mimetype];
    if (allowedExts && !allowedExts.includes(ext)) {
      throw new BadRequestException({
        code: UploadRejectionCode.EXTENSION_MISMATCH,
        message: `Extension "${ext}" does not match MIME type "${file.mimetype}". Expected: ${allowedExts.join(', ')}`,
      });
    }

    // Magic byte verification (content sniffing)
    if (!await this.verifyMagicBytesAdvanced(file.buffer, file.mimetype)) {
      throw new BadRequestException({
        code: UploadRejectionCode.SUSPICIOUS_CONTENT,
        message:
          'File content does not match declared type. The file may be corrupted or disguised.',
      });
    }
  }

  /**
   * Verify that the file buffer starts with the expected magic bytes
   * for the declared MIME type. Enhanced version checks multiple offsets
   * and validates file structure integrity.
   */
  private async verifyMagicBytesAdvanced(buffer: Buffer, mimeType: string): Promise<boolean> {
    const signatures = MAGIC_BYTES[mimeType];
    if (!signatures || signatures.length === 0) {
      return true; // No signature to check
    }

    // Check if any signature matches
    const hasValidSignature = signatures.some((sig) => {
      if (buffer.length < sig.offset + sig.bytes.length) return false;
      return sig.bytes.every(
        (byte, i) => buffer[sig.offset + i] === byte,
      );
    });

    if (!hasValidSignature) {
      return false;
    }

    // Additional integrity checks for specific formats
    if (mimeType === 'audio/mpeg') {
      return this.validateMP3Structure(buffer);
    } else if (mimeType === 'audio/wav') {
      return this.validateWAVStructure(buffer);
    } else if (mimeType === 'audio/flac' || mimeType === 'audio/x-flac') {
      return this.validateFLACStructure(buffer);
    }

    return true;
  }

  /**
   * Validate MP3 file structure integrity
   */
  private validateMP3Structure(buffer: Buffer): boolean {
    // Check for minimum viable MP3 size
    if (buffer.length < 128) return false;

    // Check for ID3v2 header size validity if present
    if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
      // ID3v2 tag present - check tag size is reasonable
      const tagSize = ((buffer[6] & 0x7f) << 21) | 
                      ((buffer[7] & 0x7f) << 14) | 
                      ((buffer[8] & 0x7f) << 7) | 
                      (buffer[9] & 0x7f);
      if (tagSize + 10 > buffer.length) return false;
    }

    return true;
  }

  /**
   * Validate WAV file structure integrity
   */
  private validateWAVStructure(buffer: Buffer): boolean {
    // Minimum WAV file size (44 bytes for header + some data)
    if (buffer.length < 44) return false;

    // Check RIFF header
    if (buffer.toString('ascii', 0, 4) !== 'RIFF') return false;
    
    // Check WAVE format
    if (buffer.toString('ascii', 8, 12) !== 'WAVE') return false;

    return true;
  }

  /**
   * Validate FLAC file structure integrity
   */
  private validateFLACStructure(buffer: Buffer): boolean {
    // Minimum FLAC file size
    if (buffer.length < 42) return false;

    // Check fLaC marker
    if (buffer.toString('ascii', 0, 4) !== 'fLaC') return false;

    return true;
  }

  /**
   * Sanitize filename to prevent directory traversal and injection attacks
   */
  private sanitizeFilename(filename: string): string {
    // Remove null bytes and trim
    let sanitized = filename.replace(/\0/g, '').trim();
    
    // Remove path components
    sanitized = path.basename(sanitized);
    
    // Replace dangerous characters with underscores
    sanitized = sanitized.replace(/[<>:"|?*]/g, '_');
    
    // Remove leading/trailing dots and spaces
    sanitized = sanitized.replace(/^[.\s]+|[.\s]+$/g, '');
    
    // Limit length
    if (sanitized.length > 200) {
      const ext = path.extname(sanitized);
      sanitized = sanitized.substring(0, 200 - ext.length) + ext;
    }
    
    return sanitized;
  }

  generateUniqueFileName(originalName: string): string {
    const ext = path.extname(originalName).toLowerCase();
    const timestamp = Date.now();
    const uuid = uuidv4();
    return `${timestamp}-${uuid}${ext}`;
  }

  async saveFile(
    file: Express.Multer.File,
  ): Promise<{ filename: string; path: string; url: string }> {
    await this.validateFile(file);

    const filename = this.generateUniqueFileName(file.originalname);
    const filePath = path.join(this.uploadDir, filename);

    try {
      // Write file with proper flags to prevent overwriting
      await fs.writeFile(filePath, file.buffer, { flag: 'wx' });

      const url = `/api/files/${filename}`;

      this.logger.log(`File saved successfully: ${filename}`);

      return {
        filename,
        path: filePath,
        url,
      };
    } catch (error) {
      this.logger.error(`Failed to save file: ${error.message}`);
      
      // Clean up partial writes
      try {
        await fs.unlink(filePath);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      
      throw new BadRequestException('Failed to save file');
    }
  }

  async deleteFile(filename: string): Promise<void> {
    const filePath = path.join(this.uploadDir, filename);

    try {
      await fs.unlink(filePath);
      this.logger.log(`File deleted successfully: ${filename}`);
    } catch (error) {
      this.logger.error(`Failed to delete file: ${error.message}`);
      throw new BadRequestException('Failed to delete file');
    }
  }

  async getFileInfo(
    filename: string,
  ): Promise<{ exists: boolean; size?: number; mimeType?: string }> {
    const filePath = path.join(this.uploadDir, filename);

    try {
      const stats = await fs.stat(filePath);
      const mimeType = mime.lookup(filePath) || 'application/octet-stream';

      return {
        exists: true,
        size: stats.size,
        mimeType,
      };
    } catch {
      return {
        exists: false,
      };
    }
  }

  getFilePath(filename: string): string {
    return path.join(this.uploadDir, filename);
  }

  async getStreamingUrl(filename: string): Promise<string> {
    const fileInfo = await this.getFileInfo(filename);

    if (!fileInfo.exists) {
      throw new BadRequestException('File not found');
    }

    return `/api/files/${filename}/stream`;
  }
}
