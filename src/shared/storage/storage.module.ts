import { Module } from '@nestjs/common';
import { FILE_STORAGE } from './file-storage.port';
import { DiskFileStorage } from './disk-file-storage';
import { FilesController } from './files.controller';

// ConfigModule es @Global (isGlobal: true en ConfigModule), así que ConfigService
// se inyecta sin importarlo aquí.
@Module({
  controllers: [FilesController],
  providers: [{ provide: FILE_STORAGE, useClass: DiskFileStorage }],
  exports: [FILE_STORAGE],
})
export class StorageModule {}
