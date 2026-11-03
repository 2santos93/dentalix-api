import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { locationNotAllowed } from './location-access';

/**
 * SEC-014: una sede desactivada conserva su historial (se lee), pero ya no
 * admite movimientos nuevos. `code` estable para que el cliente lo distinga
 * del 400 de una sede que no es de la clínica.
 */
export const LOCATION_INACTIVE_CODE = 'LOCATION_INACTIVE';
export const LOCATION_INACTIVE_MESSAGE =
  'Esta sede está desactivada: puedes consultar su historial, pero no registrar cambios en ella. Elige una sede activa.';

/** Métodos que no escriben: en una sede desactivada siguen permitidos. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * ¿La petición escribe? Sin método conocido (llamadores internos y pruebas que
 * no lo indican) se trata como lectura, que es lo que eran antes de SEC-014.
 */
export function isWriteMethod(method: string | undefined): boolean {
  return method !== undefined && !READ_METHODS.has(method.toUpperCase());
}

export function locationInactive(): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: LOCATION_INACTIVE_CODE,
    message: LOCATION_INACTIVE_MESSAGE,
  });
}

/**
 * SEC-014: la regla única para escribir EN una sede (crear algo en ella o
 * fijarla como la sede de una fila): tiene que estar activa. La usan el
 * interceptor (cabecera, auto-pin y `locationId` del cuerpo) y los casos de
 * uso que toman la sede de otra fila (la cita desde la lista de espera, las
 * ofertas de un hueco).
 */
export function assertLocationWritable(location: { isActive: boolean }): void {
  if (!location.isActive) throw locationInactive();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SEC-014: en una escritura, el `locationId` del cuerpo (altas de caja,
 * sillón, bloqueo, gasto, lista de espera, promesa de pago, tarifa,
 * convenio, excepción de horario…) no puede ser una sede desactivada. Corre
 * antes de la validación del DTO, así que solo mira un UUID de texto; uno
 * desconocido o de otra clínica no se decide aquí (el caso de uso da su 404 o
 * su 400, como siempre). `null` (fila de toda la clínica) no se mira.
 * Una consulta por id, y ninguna si no hay `locationId` o es la de la
 * cabecera, ya validada.
 */
export async function assertBodyLocationWritable(
  prisma: PrismaService,
  tenantId: string,
  body: unknown,
  method: string | undefined,
  checkedLocationId: string | undefined,
): Promise<void> {
  if (!isWriteMethod(method) || typeof body !== 'object' || body === null) {
    return;
  }
  const locationId = (body as { locationId?: unknown }).locationId;
  if (typeof locationId !== 'string' || !UUID.test(locationId)) return;
  if (locationId === checkedLocationId) return;
  const location = await prisma.runWithTenant(tenantId, (tx) =>
    tx.location.findFirst({
      where: { id: locationId, deletedAt: null },
      select: { isActive: true },
    }),
  );
  if (location) assertLocationWritable(location);
}

/**
 * Sede activa de una petición de clínica: cabecera `X-Location-Id`, VALIDADA
 * contra la clínica (una sede de otra clínica no se ignora en silencio: eso
 * devolvería datos de la sede equivocada sin avisar; se rechaza) y contra las
 * sedes permitidas del token (DX-089, claim `loc`). Sin cabecera, quien solo
 * puede trabajar en UNA sede trabaja en ella (auto-pin); si no, `undefined`
 * (vista consolidada de toda la clínica).
 *
 * SEC-014: en una ESCRITURA (`method` distinto de GET/HEAD/OPTIONS) la sede
 * resuelta tiene que estar activa: si está desactivada, 400
 * `LOCATION_INACTIVE`. Las lecturas de su historial siguen permitidas. El
 * auto-pin solo cuesta una consulta en escrituras (el claim `loc` ya excluye
 * las sedes inactivas al emitirse; esto cubre un token emitido antes de
 * desactivarla).
 *
 * La usa `TenantContextInterceptor` y, DX-359, `/me`, que no pasa por él
 * (también sirve a tokens de plataforma) pero audita en la sede del actor.
 * `/me` no pasa `method`: cambiar el propio nombre o la contraseña no escribe
 * en la sede, que allí solo etiqueta el evento de auditoría.
 */
export async function resolveActiveLocationId(
  prisma: PrismaService,
  headers: Record<string, string | string[] | undefined> | undefined,
  tenantId: string,
  allowed: readonly string[] | undefined,
  method?: string,
): Promise<string | undefined> {
  const write = isWriteMethod(method);
  const raw = headers?.['x-location-id'] ?? undefined;
  const headerLocationId = Array.isArray(raw) ? raw[0] : raw;
  if (headerLocationId) {
    const location = await prisma.runWithTenant(tenantId, (tx) =>
      tx.location.findFirst({
        where: { id: headerLocationId, deletedAt: null },
        select: { id: true, isActive: true },
      }),
    );
    if (!location) {
      throw new BadRequestException('Unknown location for this clinic');
    }
    if (allowed && !allowed.includes(location.id)) {
      throw locationNotAllowed();
    }
    if (write) assertLocationWritable(location);
    return location.id;
  }
  const pinned = allowed?.length === 1 ? allowed[0] : undefined;
  if (pinned && write) {
    const location = await prisma.runWithTenant(tenantId, (tx) =>
      tx.location.findFirst({
        where: { id: pinned, deletedAt: null },
        select: { id: true, isActive: true },
      }),
    );
    if (!location) throw locationInactive();
    assertLocationWritable(location);
  }
  return pinned;
}
