/**
 * DX-224 (A1): relleno IDEMPOTENTE de `phoneE164` en pacientes y contactos
 * responsables que ya tenían teléfono antes de la columna. La lectura es la de
 * la aplicación (libphonenumber con el prefijo por defecto de la sede), así
 * que no puede ir en SQL.
 *
 *   npm run phones:e164-backfill
 *
 * Corre con el rol de la app (DATABASE_URL, RLS FORCE). Clínica a clínica, por
 * lotes de `BATCH_SIZE` filas con clave (`ORDER BY id`, `id > último`), cada
 * lote en su transacción con el tenant fijado y un tope explícito. Sin sede
 * activa, se lee con el prefijo de la sede principal (la más antigua), como la
 * vista consolidada; un teléfono con «+» no depende de ella. Solo toca filas
 * con teléfono y sin E.164: repetirlo no cambia nada, y lo que no es un número
 * válido o es ambiguo queda en NULL. Nunca imprime un teléfono: solo recuentos.
 */
import { config as loadDotenv } from 'dotenv';
import { Prisma } from '@prisma/client';
import {
  defaultPhoneRegionIn,
  reconcilePatientPhoneE164,
  reconcileResponsiblePhoneE164,
} from '../../src/modules/patients/infrastructure/phone-e164';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { TenantContextService } from '../../src/shared/tenancy/tenant-context.service';

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
                ? await reconcilePatientPhoneE164(tx, ids, region)
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

async function main(): Promise<void> {
  loadDotenv({ quiet: true });
  const prisma = new PrismaService(new TenantContextService());
  try {
    const tenants = await prisma.tenant.findMany({
      select: { id: true, subdomain: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const tenant of tenants) {
      const counts = await backfillTenantPhoneE164(prisma, tenant.id);
      console.log(
        JSON.stringify({
          event: 'phones.e164_backfill',
          subdomain: tenant.subdomain,
          ...counts,
        }),
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    // Sin el mensaje: un error de Prisma puede citar valores.
    const code =
      error instanceof Prisma.PrismaClientKnownRequestError
        ? error.code
        : error instanceof Error
          ? error.name
          : 'unknown';
    console.error(
      JSON.stringify({ event: 'phones.e164_backfill_failed', code }),
    );
    process.exit(1);
  });
}
