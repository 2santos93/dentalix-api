import { ClinicCountry, type Prisma } from '@prisma/client';
import { loadLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import { DEFAULT_BUSINESS_HOURS_TIMEZONE } from '../../../../shared/locations/default-business-hours';
import type { NoticeResponsible } from '../../domain/communication/notice-recipient';

/** País y zona con que se cuenta la edad del paciente (DX-203). */
export interface NoticeLocation {
  country: ClinicCountry;
  timeZone: string;
}

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
 * La sede que da país y «hoy» a la regla: `locationId` (la de la cita o el
 * abono), si no la sede activa de la petición y, en la vista consolidada, la
 * principal (la viva más antigua). Sin sedes: Colombia.
 */
export async function loadNoticeLocation(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationId: string | null,
): Promise<NoticeLocation> {
  const location = await tx.location.findFirst({
    where: locationId ? { id: locationId } : { deletedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, country: true },
  });
  if (!location) {
    return {
      country: ClinicCountry.CO,
      timeZone: DEFAULT_BUSINESS_HOURS_TIMEZONE,
    };
  }
  const zones = await loadLocationTimeZones(tx, tenantId, [location.id]);
  return {
    country: location.country,
    timeZone: zones.get(location.id) ?? DEFAULT_BUSINESS_HOURS_TIMEZONE,
  };
}
