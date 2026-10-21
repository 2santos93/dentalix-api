import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpStatus,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Response } from 'express';
import { FILE_TOO_LARGE_MESSAGE } from '../domain/document-content';

/**
 * Mensajes en inglés con que `FileInterceptor` (multer/busboy, ver
 * `@nestjs/platform-express/multer/multer/multer.utils.js`) convierte sus
 * errores en 400. Nest pierde el `code` de multer y deja el mensaje, a veces
 * con ` - <campo>` o `Multipart: ` delante; por eso se reconocen por prefijo.
 */
const MULTER_MESSAGES: ReadonlyArray<[prefix: string, spanish: string]> = [
  ['Too many files', 'Solo se admite un archivo por subida.'],
  ['Unexpected file field', 'El archivo debe ir en el campo «file».'],
  ['Unexpected field', 'El archivo debe ir en el campo «file».'],
  ['Too many parts', 'El formulario enviado no es válido.'],
  ['Too many fields', 'El formulario enviado no es válido.'],
  ['Field name too long', 'El formulario enviado no es válido.'],
  [
    'Field value too long',
    'Uno de los campos del formulario es demasiado largo.',
  ],
  ['Field name nesting too deep', 'El formulario enviado no es válido.'],
  ['Field name missing', 'El formulario enviado no es válido.'],
  ['Multipart: Boundary not found', 'El formulario enviado no es válido.'],
  ['Multipart:', 'El formulario enviado está incompleto o mal formado.'],
];

function spanishMulterMessage(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const hit = MULTER_MESSAGES.find(([prefix]) => message.startsWith(prefix));
  return hit ? hit[1] : null;
}

/**
 * Solo en el controlador de documentos (DX-151): el 413 de multer
 * (`LIMIT_FILE_SIZE` → `PayloadTooLargeException('File too large')`) y sus
 * 400 salen en español. Cualquier otro 400 (los del caso de uso, los del
 * ValidationPipe) sale igual que con el filtro global: mismo cuerpo, sin
 * registro (es un 4xx).
 */
@Catch(PayloadTooLargeException, BadRequestException)
export class MultipartErrorsFilter implements ExceptionFilter {
  /** El 413 en español; otro controlador con otro tope lo cambia (DX-107). */
  protected readonly tooLargeMessage: string = FILE_TOO_LARGE_MESSAGE;

  catch(
    exception: PayloadTooLargeException | BadRequestException,
    host: ArgumentsHost,
  ): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) {
      res.end();
      return;
    }
    if (exception instanceof PayloadTooLargeException) {
      res.status(HttpStatus.PAYLOAD_TOO_LARGE).json({
        statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
        error: 'Payload Too Large',
        message: this.tooLargeMessage,
      });
      return;
    }
    const body = exception.getResponse();
    const message =
      typeof body === 'object' && body !== null
        ? (body as { message?: unknown }).message
        : body;
    const spanish = spanishMulterMessage(message);
    if (spanish) {
      res.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        message: spanish,
      });
      return;
    }
    res
      .status(exception.getStatus())
      .json(
        typeof body === 'string'
          ? { statusCode: exception.getStatus(), message: body }
          : { ...body },
      );
  }
}
