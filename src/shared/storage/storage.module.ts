import {
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FILE_STORAGE, type FileStoragePort } from './file-storage.port';
import { DiskFileStorage } from './disk-file-storage';
import {
  DiskDirectUploadInterceptor,
  DiskDriverOnlyGuard,
} from './disk-direct-upload';
import { FilesController } from './files.controller';
import { S3FileStorage, createS3Client } from './s3-file-storage';
import {
  loadStorageConfig,
  loadUploadMaxConcurrency,
  loadUploadTimeouts,
} from './storage-config';
import { errorName } from './storage-op-log';
import { UPLOAD_SLOTS, UploadSlotGuard, UploadSlots } from './upload-slots';

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

/**
 * DX-259 (OPS-039): al arrancar se comprueba el bucket (`HeadBucket`) y, si
 * no responde o las credenciales no valen, se AVISA en el log
 * (`storage.unreachable`); la API arranca igual (la readiness no mira el
 * almacén a propósito: una caída de S3 no debe sacar las réplicas) y no
 * espera a la comprobación.
 */
@Injectable()
export class StorageStartupCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('Storage');

  constructor(
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
  ) {}

  onApplicationBootstrap(): void {
    void this.storage.checkReachable().catch((err: unknown) => {
      this.logger.warn({
        event: 'storage.unreachable',
        error: errorName(err),
        cause: errorName((err as { cause?: unknown })?.cause),
      });
    });
  }
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
    {
      provide: UPLOAD_SLOTS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new UploadSlots(
          loadUploadMaxConcurrency((key) => config.get<string>(key)),
          loadUploadTimeouts((key) => config.get<string>(key)),
        ),
    },
    UploadSlotGuard,
    DiskDriverOnlyGuard,
    DiskDirectUploadInterceptor,
    StorageStartupCheck,
  ],
  exports: [FILE_STORAGE, UPLOAD_SLOTS, UploadSlotGuard],
})
export class StorageModule {}
