import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RateLimit } from '../security/rate-limit.decorator';
import { contentTypeOf, isServableContentType } from './content-type';
import { DiskFileStorage } from './disk-file-storage';
import {
  DIRECT_UPLOAD_FORBIDDEN_MESSAGE,
  DiskDirectUploadInterceptor,
  DiskDriverOnlyGuard,
  type DirectUploadRequest,
} from './disk-direct-upload';
import { MultipartErrorsFilter } from '../../modules/patient-documents/presentation/multipart-errors.filter';
import { avatarCacheControl } from './public-file-cache';
import { UploadSlotGuard, UploadSlotInterceptor } from './upload-slots';
import { isFileKey } from './file-key';
import { FILE_STORAGE, contentDispositionHeader } from './file-storage.port';
import type { FileStoragePort, SignedUrlOptions } from './file-storage.port';

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export const DIRECT_UPLOAD_MISSING_FILE_MESSAGE = 'Falta el archivo.';
export const DIRECT_UPLOAD_PROBLEMS: Record<
  'empty' | 'too_large' | 'checksum_mismatch',
  string
> = {
  empty: 'El archivo está vacío.',
  too_large: 'El archivo supera el máximo de 20 MB.',
  checksum_mismatch:
    'El archivo no coincide con su huella SHA-256. Vuelve a subirlo.',
};

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
  // DX-259 (OPS-039): ruta anónima que llega al bucket; con la caché del
  // navegador una clínica casi no la pide, así que su límite por IP es más
  // estricto que el global (RATE_LIMIT_PUBLIC_FILES_*).
  @RateLimit('public-files')
  async getAvatar(
    @Param('name') name: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | undefined> {
    const key = `avatars/${name}`;
    // isFileKey además rechaza `..` dentro del nombre, que el almacén no
    // acepta como clave (sería un 500 en vez de un 400).
    if (!SAFE_NAME.test(name) || !isFileKey(key)) {
      throw new BadRequestException('Invalid file name');
    }
    res.set('Cache-Control', avatarCacheControl(name));
    // Revalidación (If-None-Match): basta un HeadObject; el objeto solo se
    // descarga si cambió. `req.fresh` (Express) compara If-None-Match con la
    // ETag puesta y, sin cuerpo, el `send()` de Express responde 304.
    if (req.headers['if-none-match']) {
      const info = await this.storage.stat(key);
      if (!info) throw new NotFoundException('File not found');
      if (info.etag) res.set('ETag', info.etag);
      if (info.etag && req.fresh) return undefined;
    }
    const file = await this.storage.openRead(key);
    if (!file) {
      throw new NotFoundException('File not found');
    }
    if (file.etag) res.set('ETag', file.etag);
    // El tipo sale de la extensión (la fija el caso de uso), no de lo
    // guardado: nunca se sirve como HTML algo subido como avatar.
    res.set('Content-Type', contentTypeOf(key));
    if (file.size !== null) res.set('Content-Length', String(file.size));
    return new StreamableFile(file.stream);
  }

  /**
   * DX-259: la «subida directa» del adaptador de DISCO (solo desarrollo y
   * tests): recibe el mismo formulario que el POST prefirmado de S3 (los
   * campos firmados por `createDirectUpload` y el fichero al final, en
   * `file`). Orden: con S3, 404 antes de nada (`DiskDriverOnlyGuard`); plaza
   * del semáforo con plazos (`UploadSlotGuard`); firma comprobada antes de
   * aceptar el fichero (`DiskDirectUploadInterceptor`, 403 sin escribirlo);
   * y se guarda bajo su clave si el tamaño y el SHA-256 cuadran. Errores de
   * multer en español (`MultipartErrorsFilter`).
   */
  @Post('uploads')
  @HttpCode(204)
  @ApiExcludeEndpoint()
  @Header('Cache-Control', 'no-store')
  @UseGuards(DiskDriverOnlyGuard, UploadSlotGuard)
  @UseInterceptors(UploadSlotInterceptor, DiskDirectUploadInterceptor)
  @UseFilters(MultipartErrorsFilter)
  async directUpload(@Req() req: DirectUploadRequest): Promise<void> {
    const upload = req.directUpload;
    const file = req.file;
    if (!(this.storage instanceof DiskFileStorage)) {
      throw new NotFoundException();
    }
    if (!upload) throw new ForbiddenException(DIRECT_UPLOAD_FORBIDDEN_MESSAGE);
    if (!file) {
      throw new BadRequestException(DIRECT_UPLOAD_MISSING_FILE_MESSAGE);
    }
    const outcome = await this.storage.acceptDirectUpload(upload, file.path);
    if (outcome !== 'ok') {
      throw new BadRequestException(DIRECT_UPLOAD_PROBLEMS[outcome]);
    }
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
    const file = await this.storage.openRead(key);
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
    return new StreamableFile(file.stream);
  }
}
