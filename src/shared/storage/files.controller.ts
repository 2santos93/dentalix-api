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
import { contentTypeOf, isServableContentType } from './content-type';
import { DiskFileStorage } from './disk-file-storage';
import { isFileKey } from './file-key';
import { FILE_STORAGE, contentDispositionHeader } from './file-storage.port';
import type { FileStoragePort, SignedUrlOptions } from './file-storage.port';

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Opciones de la URL firmada tal como llegan en la query. Una `disposition`
 * desconocida es null (= firma inválida); sin `disposition` no hay opciones.
 */
function signedOptionsOf(
  disposition: string | undefined,
  filename: string | undefined,
  type: string | undefined,
): SignedUrlOptions | undefined | null {
  if (disposition === undefined) {
    // Nombre o tipo sueltos no los firma nunca getSignedUrl: manipulación.
    return filename === undefined && type === undefined ? undefined : null;
  }
  if (disposition !== 'inline' && disposition !== 'attachment') return null;
  return {
    disposition,
    ...(filename !== undefined ? { filename } : {}),
    ...(type !== undefined ? { contentType: type } : {}),
  };
}

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
    const key = `avatars/${name}`;
    // isFileKey además rechaza `..` dentro del nombre, que el almacén no
    // acepta como clave (sería un 500 en vez de un 400).
    if (!SAFE_NAME.test(name) || !isFileKey(key)) {
      throw new BadRequestException('Invalid file name');
    }
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
   *
   * DX-151: la disposición, el nombre y el tipo van firmados en la query. Esta
   * ruta (y solo esta) se deja enmarcar desde cualquier origen para que la
   * web muestre el PDF en su visor en desarrollo. Sin `sandbox` en la CSP
   * (Chromium deja en blanco el visor PDF en un documento en sandbox): lo
   * compensa que el tipo servido es siempre de la lista blanca (nada de
   * HTML ni SVG), con `nosniff` de helmet, URL que caduca y `no-store`.
   */
  @Get('signed')
  @ApiExcludeEndpoint()
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  @Header('Cache-Control', 'private, no-store')
  async getSigned(
    @Query('key') key: string | undefined,
    @Query('expires') expires: string | undefined,
    @Query('signature') signature: string | undefined,
    @Query('disposition') disposition: string | undefined,
    @Query('filename') filename: string | undefined,
    @Query('type') type: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    if (!(this.storage instanceof DiskFileStorage)) {
      throw new NotFoundException();
    }
    const options = signedOptionsOf(disposition, filename, type);
    if (
      typeof key !== 'string' ||
      typeof expires !== 'string' ||
      typeof signature !== 'string' ||
      options === null ||
      // Defensa en profundidad: getSignedUrl ya no firma otro tipo.
      (options?.contentType !== undefined &&
        !isServableContentType(options.contentType)) ||
      !this.storage.verifySignedUrl(key, expires, signature, options)
    ) {
      throw new ForbiddenException('Invalid or expired signature');
    }
    const file = await this.storage.read(key);
    if (!file) {
      throw new NotFoundException('File not found');
    }
    res.set('Content-Type', options?.contentType ?? contentTypeOf(key));
    if (options) {
      res.set('Content-Disposition', contentDispositionHeader(options));
    }
    // helmet pone X-Frame-Options: SAMEORIGIN y frame-ancestors 'self' en
    // toda la API; aquí se sustituyen (la web está en otro origen).
    res.removeHeader('X-Frame-Options');
    res.set('Content-Security-Policy', 'frame-ancestors *');
    return new StreamableFile(file.bytes);
  }
}
