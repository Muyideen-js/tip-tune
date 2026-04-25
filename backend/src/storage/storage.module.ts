import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { StorageService } from './storage.service';
import { StorageController } from './storage.controller';
import { STORAGE_PROVIDER } from './storage-provider.interface';

@Module({
  imports: [
    ConfigModule,
    MulterModule.register({
      limits: {
        fileSize: 50 * 1024 * 1024, // 50MB
      },
    }),
  ],
  controllers: [StorageController],
  providers: [
    StorageService,
    // Bind the abstract token to the local-filesystem implementation.
    // To swap in a remote backend (S3, GCS, etc.) replace this binding.
    { provide: STORAGE_PROVIDER, useExisting: StorageService },
  ],
  exports: [StorageService, STORAGE_PROVIDER],
})
export class StorageModule {}
