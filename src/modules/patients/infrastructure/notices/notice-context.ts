import type { Prisma } from '@prisma/client';
import {
  locationTimeZoneRequired,
  requireLocationTimeZone,
} from '../../../../shared/locations/location-time-zone';
import { resolveReferenceLocation } from '../../../../shared/locations/reference-location';
import type {
  NoticeLocation,
  NoticeResponsible,
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
 * La sede que da país y «hoy» a la regla: `locationId` (la de la cita o el
 * abono, aunque se haya retirado después) o, sin ella, la sede principal
 * (R6). Clínica sin sedes activas: 409 `LOCATION_REQUIRED`; sede sin zona:
 * 409 `LOCATION_TIMEZONE_REQUIRED`. Nunca un país ni una zona por defecto.
 */
export async function loadNoticeLocation(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationId: string | null,
): Promise<NoticeLocation> {
  if (!locationId) {
    const { country, timeZone } = await resolveReferenceLocation(
      tx,
      tenantId,
      null,
    );
    return { country, timeZone };
  }
  const location = await tx.location.findFirst({
    where: { id: locationId, tenantId },
    select: { id: true, country: true, timeZone: true },
  });
  if (!location) throw locationTimeZoneRequired(locationId);
  return {
    country: location.country,
    timeZone: requireLocationTimeZone(location),
  };
}
