import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import {
  defaultPhoneRegionIn,
  reconcilePatientPhoneE164FromOrigin,
  reconcileResponsiblePhoneE164,
} from './phone-e164';

/**
 * DX-224 (A1): relleno IDEMPOTENTE de `phoneE164` en pacientes y contactos
 * responsables que ya tenían teléfono. Lo usan el trabajo programado
 * (`patients.phone-e164-backfill`, cada hora) y `npm run phones:e164-backfill`.
 * Clínica a clínica, por lotes con clave (`ORDER BY id`, `id > último`), cada
 * lote en su transacción con el tenant fijado y un tope. Solo toca filas con
 * teléfono y sin E.164; lo que no es un número válido o es ambiguo queda NULL.
 * Prefijo: el de la sede del lote de importación del paciente si lo hay; si
 * no, el de la sede principal (la más antigua). Nunca registra un teléfono.
 */
export const BATCH_SIZE = 1000;
export const BATCH_TIMEOUT_MS = 60_000;

export interface PhoneE164BackfillCounts {
  patientsScanned: number;
  patientsWritten: number;
  responsiblesScanned: number;
  responsiblesWritten: number;
}

type Table = 'patients' | 'patient_responsible_parties';

/** El siguiente lote de ids con teléfono y sin E.164, después de `after`. */
async function pendingIds(
  tx: Prisma.TransactionClient,
  table: Table,
  after: string | null,
  size: number,
): Promise<string[]> {
  const name = Prisma.raw(`"${table}"`);
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM ${name}
     WHERE "phone" IS NOT NULL AND "phoneE164" IS NULL
       AND (${after}::uuid IS NULL OR "id" > ${after}::uuid)
     ORDER BY "id" LIMIT ${size}`;
  return rows.map((r) => r.id);
}

export async function backfillTenantPhoneE164(
  prisma: PrismaService,
  tenantId: string,
  batchSize = BATCH_SIZE,
): Promise<PhoneE164BackfillCounts> {
  const counts: PhoneE164BackfillCounts = {
    patientsScanned: 0,
    patientsWritten: 0,
    responsiblesScanned: 0,
    responsiblesWritten: 0,
  };
  const options = { timeout: BATCH_TIMEOUT_MS };
  for (const table of ['patients', 'patient_responsible_parties'] as const) {
    let after: string | null = null;
    for (;;) {
      const done: { scanned: number; written: number; last: string | null } =
        await prisma.runWithTenant(
          tenantId,
          async (tx) => {
            const ids = await pendingIds(tx, table, after, batchSize);
            if (ids.length === 0) return { scanned: 0, written: 0, last: null };
            const region = await defaultPhoneRegionIn(tx);
            const written =
              table === 'patients'
                ? await reconcilePatientPhoneE164FromOrigin(tx, ids, region)
                : await reconcileResponsiblePhoneE164(tx, ids, region);
            return {
              scanned: ids.length,
              written,
              last: ids[ids.length - 1],
            };
          },
          options,
        );
      if (done.scanned === 0) break;
      if (table === 'patients') {
        counts.patientsScanned += done.scanned;
        counts.patientsWritten += done.written;
      } else {
        counts.responsiblesScanned += done.scanned;
        counts.responsiblesWritten += done.written;
      }
      after = done.last;
      if (done.scanned < batchSize) break;
    }
  }
  return counts;
}
