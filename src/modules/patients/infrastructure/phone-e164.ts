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

interface PhoneRow {
  id: string;
  phone: string;
  /** Región de la sede del lote de importación del paciente, si lo hay. */
  region?: string | null;
}

async function pending(
  tx: Tx,
  table: Table,
  slice: string[],
  ownSede: boolean,
): Promise<PhoneRow[]> {
  if (table === 'patients' && ownSede) {
    // M1: un paciente importado en el lote de una sede se lee con SU prefijo.
    return tx.$queryRaw<PhoneRow[]>`
      SELECT p."id", p."phone", l."defaultPhoneRegion" AS "region"
        FROM "patients" p
        LEFT JOIN "patient_import_batches" b
          ON b."tenantId" = p."tenantId" AND b."id" = p."import_batch_id"
        LEFT JOIN "locations" l
          ON l."tenantId" = b."tenantId" AND l."id" = b."locationId"
       WHERE p."id" = ANY(${slice}::uuid[])
         AND p."phone" IS NOT NULL AND p."phoneE164" IS NULL`;
  }
  const name = Prisma.raw(`"${table}"`);
  return tx.$queryRaw<PhoneRow[]>`
    SELECT "id", "phone" FROM ${name}
     WHERE "id" = ANY(${slice}::uuid[])
       AND "phone" IS NOT NULL AND "phoneE164" IS NULL`;
}

async function reconcile(
  tx: Tx,
  table: Table,
  ids: readonly string[],
  region: PhoneRegion | null,
  ownSede = false,
  markChecked = false,
): Promise<number> {
  let written = 0;
  const name = Prisma.raw(`"${table}"`);
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const rows = await pending(tx, table, slice, ownSede);
    const pairs = rows.flatMap((r) => {
      const e164 = storedPhoneE164(
        r.phone,
        phoneRegionOrNull(r.region) ?? region,
      );
      return e164 ? [{ id: r.id, e164 }] : [];
    });
    if (pairs.length > 0) {
      await tx.$executeRaw`
        UPDATE ${name} t SET "phoneE164" = v.e164
          FROM unnest(${pairs.map((p) => p.id)}::uuid[],
                      ${pairs.map((p) => p.e164)}::text[]) AS v(id, e164)
         WHERE t."id" = v.id AND t."phoneE164" IS NULL`;
      written += pairs.length;
    }
    if (markChecked) {
      // Lo leído y sin E.164 no se vuelve a leer hasta que `phone` cambie.
      const resolved = new Set(pairs.map((p) => p.id));
      const unresolved = rows
        .map((r) => r.id)
        .filter((id) => !resolved.has(id));
      if (unresolved.length > 0) {
        await tx.$executeRaw`
          UPDATE ${name} SET "phoneE164CheckedAt" = now()
           WHERE "id" = ANY(${unresolved}::uuid[]) AND "phoneE164" IS NULL`;
      }
    }
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

/**
 * Lo mismo para el relleno de filas antiguas (M1): cada paciente importado se
 * lee con el prefijo de la sede de SU lote; el resto, con `fallback` (la sede
 * principal). Sin lote no se sabe en qué sede se escribió.
 */
export function reconcilePatientPhoneE164FromOrigin(
  tx: Tx,
  ids: readonly string[],
  fallback: PhoneRegion | null,
): Promise<number> {
  return reconcile(tx, 'patients', ids, fallback, true, true);
}

/** Lo mismo para los contactos responsables (escritura en vivo, sin marca). */
export function reconcileResponsiblePhoneE164(
  tx: Tx,
  ids: readonly string[],
  region: PhoneRegion | null,
): Promise<number> {
  return reconcile(tx, 'patient_responsible_parties', ids, region);
}

/** El relleno de responsables: lo que no se lee se marca como revisado. */
export function reconcileResponsiblePhoneE164Backfill(
  tx: Tx,
  ids: readonly string[],
  region: PhoneRegion | null,
): Promise<number> {
  return reconcile(tx, 'patient_responsible_parties', ids, region, false, true);
}
