import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable, finalize } from 'rxjs';
import {
  UPLOAD_BUSY_RETRY_AFTER_SECONDS,
  UploadSlots,
} from '../../../shared/storage/upload-slots';

/** SEC-046: semáforo de las lecturas de ficheros de importación. */
export const IMPORT_READ_SLOTS = Symbol('IMPORT_READ_SLOTS');

export const IMPORT_READ_CLINIC_BUSY_MESSAGE =
  'Ya se está leyendo otro archivo de importación de esta clínica. Vuelve a intentarlo en unos segundos.';

export const IMPORT_READ_BUSY_MESSAGE =
  'Hay otras importaciones leyéndose ahora mismo. Vuelve a intentarlo en unos segundos.';

export const IMPORT_READ_UNAUTHENTICATED_MESSAGE =
  'Inicia sesión para importar pacientes.';

interface ReadRequest {
  user?: { tenantId?: string };
}

interface ReadResponse {
  setHeader(name: string, value: string): unknown;
}

/**
 * SEC-046: leer un fichero de importación (inspect, dry-run y hoja de saldos)
 * puede ocupar decenas de MB y segundos de CPU. Como mucho
 * `PATIENT_IMPORT_MAX_CONCURRENCY` lecturas a la vez en la réplica (2) y
 * `PATIENT_IMPORT_MAX_CONCURRENCY_PER_CLINIC` por clínica (1).
 *
 * La plaza se toma DESPUÉS de recibir el cuerpo: va en `@UseInterceptors`
 * detrás del `FileInterceptor` (multer a disco). La recepción del cuerpo la
 * acotan el semáforo y los plazos de las subidas de DX-259
 * (`UploadSlotGuard`/`UploadSlotInterceptor`), así que un cliente que gotea
 * el cuerpo no retiene ninguna plaza de lectura. Sin plaza, 503 en español
 * con `Retry-After` al momento (sin cola); el temporal lo borra
 * `UploadSlotInterceptor`. Corre después de `JwtAuthGuard` y `RolesGuard`:
 * un anónimo o un no-ADMIN no llega aquí. La plaza vuelve cuando termina el
 * handler (bien o con error).
 */
@Injectable()
export class ImportReadSlotInterceptor implements NestInterceptor {
  constructor(@Inject(IMPORT_READ_SLOTS) private readonly slots: UploadSlots) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const tenantId = http.getRequest<ReadRequest>().user?.tenantId;
    // Sin usuario autenticado nunca hay plaza (estaría mal colocado).
    if (!tenantId) {
      throw new UnauthorizedException(IMPORT_READ_UNAUTHENTICATED_MESSAGE);
    }
    const got = this.slots.acquire(tenantId);
    if ('busy' in got) {
      http
        .getResponse<ReadResponse>()
        .setHeader('Retry-After', String(UPLOAD_BUSY_RETRY_AFTER_SECONDS));
      throw new ServiceUnavailableException(
        got.busy === 'key'
          ? IMPORT_READ_CLINIC_BUSY_MESSAGE
          : IMPORT_READ_BUSY_MESSAGE,
      );
    }
    return next.handle().pipe(finalize(got.release));
  }
}
