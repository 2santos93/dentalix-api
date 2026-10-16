import { Prisma } from '@prisma/client';
import { DEFAULT_BUSINESS_HOURS_TIMEZONE } from './default-business-hours';

/**
 * Zona IANA de cada sede pedida, leída de su horario (`LocationSchedule`) en
 * UNA consulta. Una sede sin horario configurado usa la zona con la que nace
 * uno nuevo (`DEFAULT_BUSINESS_HOURS_TIMEZONE`), así "hoy" nunca cae en el UTC
 * del servidor. `tenantId` va explícito además de RLS.
 *
 * La usan la regla de anulación de abonos (SEC-013) y el `canVoid` de la caja
 * y del estado de cuenta (DX-057): las tres tienen que ver el MISMO "hoy".
 */
export async function resolveLocationTimeZones(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationIds: readonly string[],
): Promise<(locationId: string) => string> {
  const ids = [...new Set(locationIds)];
  const schedules =
    ids.length === 0
      ? []
      : await tx.locationSchedule.findMany({
          where: { tenantId, locationId: { in: ids }, deletedAt: null },
          select: { locationId: true, timezone: true },
        });
  const byLocation = new Map(schedules.map((s) => [s.locationId, s.timezone]));
  return (locationId) =>
    byLocation.get(locationId) ?? DEFAULT_BUSINESS_HOURS_TIMEZONE;
}
