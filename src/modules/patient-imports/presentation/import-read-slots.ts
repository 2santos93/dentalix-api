import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import {
  SlotGuard,
  UploadSlots,
  type SlotBusy,
  type SlotRequest,
} from '../../../shared/storage/upload-slots';

/** SEC-046: semáforo de las lecturas de ficheros de importación. */
export const IMPORT_READ_SLOTS = Symbol('IMPORT_READ_SLOTS');

export const IMPORT_READ_CLINIC_BUSY_MESSAGE =
  'Ya se está leyendo otro archivo de importación de esta clínica. Vuelve a intentarlo en unos segundos.';

export const IMPORT_READ_BUSY_MESSAGE =
  'Hay otras importaciones leyéndose ahora mismo. Vuelve a intentarlo en unos segundos.';

/**
 * SEC-046: leer un fichero de importación (inspect, dry-run y hoja de saldos)
 * puede ocupar ~85 MB y segundos de CPU. Como mucho
 * `PATIENT_IMPORT_MAX_CONCURRENCY` lecturas a la vez en la réplica (2) y
 * `PATIENT_IMPORT_MAX_CONCURRENCY_PER_CLINIC` por clínica (1); sin plaza, 503
 * en español con `Retry-After`, sin leer el cuerpo.
 *
 * Va en `@UseGuards` del MÉTODO, así que corre después de `JwtAuthGuard` y
 * `RolesGuard` del controlador: un anónimo o un no-ADMIN no ocupa plaza. Se
 * empareja con `UploadSlotInterceptor` (el primero de `@UseInterceptors`),
 * que devuelve la plaza y borra el temporal de multer al terminar el handler.
 */
@Injectable()
export class ImportReadSlotGuard extends SlotGuard {
  constructor(
    @Inject(IMPORT_READ_SLOTS) protected readonly slots: UploadSlots,
  ) {
    super();
  }

  protected override keyOf(req: SlotRequest): string {
    const tenantId = req.user?.tenantId;
    // Sin usuario autenticado nunca hay plaza (el guard estaría mal colocado).
    if (!tenantId) throw new UnauthorizedException();
    return tenantId;
  }

  protected override busyMessage(busy: SlotBusy): string {
    return busy === 'key'
      ? IMPORT_READ_CLINIC_BUSY_MESSAGE
      : IMPORT_READ_BUSY_MESSAGE;
  }
}
