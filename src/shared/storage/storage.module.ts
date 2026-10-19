import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FILE_STORAGE, FileStoragePort } from './file-storage.port';
import { DiskFileStorage } from './disk-file-storage';
import { FilesController } from './files.controller';
import { S3FileStorage, createS3Client } from './s3-file-storage';
import { loadStorageConfig } from './storage-config';

/**
 * Elige el adaptador según `STORAGE_DRIVER` (DX-084): `s3` (S3, R2, MinIO) o
 * `disk` (solo fuera de producción; lo garantiza `validateEnv`).
 */
export function createFileStorage(config: ConfigService): FileStoragePort {
  const cfg = loadStorageConfig((key) => config.get<string>(key));
  return cfg.driver === 's3'
    ? new S3FileStorage(createS3Client(cfg), cfg)
    : new DiskFileStorage(cfg);
}

// ConfigModule es @Global (isGlobal: true en ConfigModule), así que ConfigService
// se inyecta sin importarlo aquí.
@Module({
  controllers: [FilesController],
  providers: [
    {
      provide: FILE_STORAGE,
      inject: [ConfigService],
      useFactory: createFileStorage,
    },
  ],
  exports: [FILE_STORAGE],
})
export class StorageModule {}
