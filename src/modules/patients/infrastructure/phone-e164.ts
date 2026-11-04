import { Prisma } from '@prisma/client';
import {
  phoneRegionOrNull,
  type PhoneRegion,
} from '../../../shared/phone/phone-number';
import { storedPhoneE164 } from '../domain/caller-lookup/caller-phone';

/**
 * DX-224 (A1): mantiene `phoneE164` de pacientes y contactos responsables. El
 * trigger `dx_phone_e164_stale` lo pone a NULL cuando `phone` cambia; aquí se
 * vuelve a escribir, DESPUÉS y con una sentencia que no toca `phone` (así el
 * trigger no vuelve a dispararse). Toda escritura de un teléfono llama a
 * `reconcile…` con las filas que tocó, dentro de su transacción.
 */

type Tx = Prisma.TransactionClient;

const CHUNK = 1000;

/**
 * La región por defecto de la sede activa o, sin sede activa (vista
 * consolidada), de la principal (la más antigua): la misma regla que
 * `PrismaPatientCommunicationRepository.defaultPhoneRegion`.
 */
export async function defaultPhoneRegionIn(
  tx: Tx,
  locationId?: string | null,
): Promise<PhoneRegion | null> {
  const location = await tx.location.findFirst({
    where: { deletedAt: null, ...(locationId ? { id: locationId } : {}) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { defaultPhoneRegion: true },
  });
  return phoneRegionOrNull(location?.defaultPhoneRegion);
}

type Table = 'patients' | 'patient_responsible_parties';

async function reconcile(
  tx: Tx,
  table: Table,
  ids: readonly string[],
  region: PhoneRegion | null,
): Promise<number> {
  let written = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const name = Prisma.raw(`"${table}"`);
    const rows = await tx.$queryRaw<{ id: string; phone: string }[]>`
      SELECT "id", "phone" FROM ${name}
       WHERE "id" = ANY(${slice}::uuid[])
         AND "phone" IS NOT NULL AND "phoneE164" IS NULL`;
    const pairs = rows.flatMap((r) => {
      const e164 = storedPhoneE164(r.phone, region);
      return e164 ? [{ id: r.id, e164 }] : [];
    });
    if (pairs.length === 0) continue;
    await tx.$executeRaw`
      UPDATE ${name} t SET "phoneE164" = v.e164
        FROM unnest(${pairs.map((p) => p.id)}::uuid[],
                    ${pairs.map((p) => p.e164)}::text[]) AS v(id, e164)
       WHERE t."id" = v.id AND t."phoneE164" IS NULL`;
    written += pairs.length;
  }
  return written;
}

/** Rellena `phoneE164` de los pacientes con teléfono y sin él. Devuelve cuántos. */
export function reconcilePatientPhoneE164(
  tx: Tx,
  ids: readonly string[],
  region: PhoneRegion | null,
): Promise<number> {
  return reconcile(tx, 'patients', ids, region);
}

/** Lo mismo para los contactos responsables. */
export function reconcileResponsiblePhoneE164(
  tx: Tx,
  ids: readonly string[],
  region: PhoneRegion | null,
): Promise<number> {
  return reconcile(tx, 'patient_responsible_parties', ids, region);
}
