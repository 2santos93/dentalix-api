import type { Prisma } from '@prisma/client';
import {
  locationTimeZoneRequired,
  requireLocationTimeZone,
} from '../../../../shared/locations/location-time-zone';
import { resolveReferenceLocation } from '../../../../shared/locations/reference-location';
import type {
  NoticeResponsible,
  NoticeSettings,
} from '../../domain/communication/notice-recipient';

/**
 * Los responsables VIVOS del paciente para la regla de destinatario
 * (notice-recipient.ts), en orden de alta, dentro de la transacción del
 * llamador (bajo su RLS). Un paciente responsable retirado no cuenta; su
 * email es el de su ficha y su baja o su canal distinto de EMAIL (DX-128)
 * lo sacan de los envíos automáticos.
 */
export async function loadNoticeResponsibles(
  tx: Prisma.TransactionClient,
  patientId: string,
): Promise<NoticeResponsible[]> {
  const rows = await tx.patientResponsibleParty.findMany({
    where: { patientId, deletedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      fullName: true,
      email: true,
      isPayer: true,
      receivesNotices: true,
      responsiblePatient: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
          deletedAt: true,
          contactChannel: true,
          reminderOptOutAt: true,
        },
      },
    },
  });
  const out: NoticeResponsible[] = [];
  for (const row of rows) {
    const p = row.responsiblePatient;
    if (p?.deletedAt) continue;
    out.push({
      id: row.id,
      name: p ? `${p.firstName} ${p.lastName}` : (row.fullName ?? ''),
      email: p ? p.email : row.email,
      isPayer: row.isPayer,
      receivesNotices: row.receivesNotices,
      optedOut: p
        ? p.reminderOptOutAt !== null || p.contactChannel !== 'EMAIL'
        : false,
    });
  }
  return out;
}

/**
 * Mayoría de edad de la clínica (DX-328), dentro de la transacción del
 * llamador. No hay valor por defecto: la columna es NOT NULL.
 */
export async function loadTenantMajorityAge(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<number> {
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { majorityAge: true },
  });
  return tenant.majorityAge;
}

/**
 * Con qué se cuenta la edad del paciente (DX-203, DX-328):
 * - la zona da «hoy». Sale de `locationId` (la sede de la cita o el abono,
 *   aunque se haya retirado después) o, sin ella, de la sede activa o la
 *   principal (R6). Clínica sin sedes activas: 409 `LOCATION_REQUIRED`; sede
 *   sin zona: 409 `LOCATION_TIMEZONE_REQUIRED`. Nunca una zona por defecto;
 * - la mayoría de edad es la de la clínica (`tenants.majorityAge`), nunca la
 *   de la sede.
 */
export async function loadNoticeSettings(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationId: string | null,
): Promise<NoticeSettings> {
  const timeZone = await loadNoticeTimeZone(tx, tenantId, locationId);
  return { timeZone, majorityAge: await loadTenantMajorityAge(tx, tenantId) };
}

async function loadNoticeTimeZone(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationId: string | null,
): Promise<string> {
  if (!locationId) {
    return (await resolveReferenceLocation(tx, tenantId, null)).timeZone;
  }
  const location = await tx.location.findFirst({
    where: { id: locationId, tenantId },
    select: { id: true, timeZone: true },
  });
  if (!location) throw locationTimeZoneRequired(locationId);
  return requireLocationTimeZone(location);
}
