import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { contentTypeOf } from './content-type';
import { DiskFileStorage } from './disk-file-storage';
import { FILE_STORAGE } from './file-storage.port';
import type { FileStoragePort } from './file-storage.port';

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Sirve los ficheros PÚBLICOS (avatares) leyendo del almacén configurado
 * (disco o bucket S3, DX-084): la URL es estable, cualquier réplica la sirve
 * y el bucket no necesita ser público.
 */
@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
  ) {}

  @Get('avatars/:name')
  // helmet deja CORP en same-origin para toda la API; los avatares son la
  // excepción porque la web (otro origen, y dominios de marca blanca) los
  // incrusta con <img>.
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  async getAvatar(
    @Param('name') name: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    if (!SAFE_NAME.test(name) || name.startsWith('.')) {
      throw new BadRequestException('Invalid file name');
    }
    const key = `avatars/${name}`;
    const file = await this.storage.read(key);
    if (!file) {
      throw new NotFoundException('File not found');
    }
    // El tipo sale de la extensión (la fija el caso de uso), no de lo
    // guardado: nunca se sirve como HTML algo subido como avatar.
    res.set('Content-Type', contentTypeOf(key));
    return new StreamableFile(file.bytes);
  }

  /**
   * URL firmada del adaptador de DISCO (solo desarrollo). Con S3 las URL
   * firmadas van directas al bucket y esta ruta no existe (404).
   */
  @Get('signed')
  @ApiExcludeEndpoint()
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  @Header('Cache-Control', 'private, no-store')
  async getSigned(
    @Query('key') key: string | undefined,
    @Query('expires') expires: string | undefined,
    @Query('signature') signature: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    if (!(this.storage instanceof DiskFileStorage)) {
      throw new NotFoundException();
    }
    if (
      !key ||
      !expires ||
      !signature ||
      !this.storage.verifySignedUrl(key, expires, signature)
    ) {
      throw new ForbiddenException('Invalid or expired signature');
    }
    const file = await this.storage.read(key);
    if (!file) {
      throw new NotFoundException('File not found');
    }
    res.set('Content-Type', contentTypeOf(key));
    return new StreamableFile(file.bytes);
  }
}
