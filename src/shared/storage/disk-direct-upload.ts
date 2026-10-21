import {
  BadRequestException,
  CallHandler,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NestInterceptor,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import multer from 'multer';
import type { Observable } from 'rxjs';
import {
  DiskFileStorage,
  type VerifiedDirectUpload,
} from './disk-file-storage';
import { FILE_STORAGE, type FileStoragePort } from './file-storage.port';
import { UPLOAD_TEMP_DIR } from './local-file';

/** Tope de la subida directa del disco: el de los documentos (20 MB). */
export const DISK_DIRECT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

export const DIRECT_UPLOAD_FORBIDDEN_MESSAGE =
  'La autorización de subida no es válida o caducó. Vuelve a intentarlo.';
export const DIRECT_UPLOAD_TOO_LARGE_MESSAGE =
  'El archivo supera el máximo de 20 MB.';

/** La petición tras `DiskDirectUploadInterceptor`: la subida ya verificada. */
export interface DirectUploadRequest extends Request {
  directUpload?: VerifiedDirectUpload;
}

/**
 * DX-259: `POST /files/uploads` solo existe con el almacén en DISCO. Va
 * ANTES del semáforo: con S3 un anónimo recibe 404 sin ocupar plaza ni
 * escribir nada.
 */
@Injectable()
export class DiskDriverOnlyGuard implements CanActivate {
  constructor(
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
  ) {}

  canActivate(): boolean {
    if (!(this.storage instanceof DiskFileStorage)) {
      throw new NotFoundException();
    }
    return true;
  }
}

/** Error de multer → la excepción HTTP que traduce `MultipartErrorsFilter`. */
function toHttpError(err: unknown): HttpException {
  if (err instanceof HttpException) return err;
  if (err instanceof multer.MulterError) {
    return err.code === 'LIMIT_FILE_SIZE'
      ? new PayloadTooLargeException(DIRECT_UPLOAD_TOO_LARGE_MESSAGE)
      : new BadRequestException(err.message);
  }
  return new BadRequestException('Multipart: formulario mal formado');
}

/**
 * Multer de la subida directa del disco con la firma comprobada ANTES de
 * aceptar el fichero: los campos van antes que `file` (como en el POST de
 * S3), así que `fileFilter` ya los tiene. Con la firma mal o caducada, 403 y
 * el fichero no se escribe en disco.
 */
@Injectable()
export class DiskDirectUploadInterceptor implements NestInterceptor {
  constructor(
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const storage = this.storage;
    if (!(storage instanceof DiskFileStorage)) throw new NotFoundException();
    const http = context.switchToHttp();
    const req = http.getRequest<DirectUploadRequest>();
    const res = http.getResponse<Response>();
    const upload = multer({
      dest: UPLOAD_TEMP_DIR,
      limits: {
        fileSize: DISK_DIRECT_UPLOAD_MAX_BYTES,
        files: 1,
        fields: 10,
        fieldSize: 8 * 1024,
      },
      fileFilter: (request, _file, accept) => {
        const verified = storage.verifyDirectUpload(
          (request.body ?? {}) as Record<string, unknown>,
        );
        if (!verified) {
          accept(new ForbiddenException(DIRECT_UPLOAD_FORBIDDEN_MESSAGE));
          return;
        }
        (request as DirectUploadRequest).directUpload = verified;
        accept(null, true);
      },
    }).single('file');
    await new Promise<void>((resolve, reject) => {
      upload(req, res, (err: unknown) =>
        err ? reject(toHttpError(err)) : resolve(),
      );
    });
    return next.handle();
  }
}
