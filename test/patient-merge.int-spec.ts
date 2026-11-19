import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPatientMergeRepository } from '../src/modules/patient-merge/infrastructure/prisma-patient-merge.repository';
import { MERGE_TABLE_CATEGORY } from '../src/modules/patient-merge/domain/merge-categories';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import { NO_APP_UPDATE_DELETE } from '../prisma/append-only-tables';
import { seedDemo } from '../prisma/seed-demo';
import { purgeDemoTenants } from './support/demo-tenant-purge';
import { purgeTenants } from './support/tenant-purge';
import {
  holdLock,
  settle,
  waitForLockWaiters,
} from './support/postgres-concurrency';

// DX-266 contra Postgres. La fusión la hace `dx_merge_patients` (SECURITY
// DEFINER) llamada como la app (DATABASE_URL, dentalix_app, RLS FORCE);
// `owner` (DIRECT_URL) siembra la demo (DX-335: decenas de pacientes con
// citas, HC, odontograma, planes, pagos, coberturas, recalls…) y comprueba.
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaPatientMergeRepository(prisma, tenantContext);

class Rollback extends Error {}

/**
 * Columnas de paciente que NO están en `dx_patient_merge_tables()`, cada una
 * con su motivo (ver el informe de DX-266). Una columna nueva que apunte a un
 * paciente hace fallar el test del catálogo hasta que se decida qué hace la
 * fusión con ella.
 */
const NOT_MOVED: Record<string, string> = {
  // La auditoría es historia: cada evento sigue con el paciente de entonces;
  // la fusión deja uno en cada paciente que los enlaza.
  'audit_events.patientId': 'historia de la auditoría (append-only)',
  // La cartera la recalcula la BD (patient_ledgers_refresh) para los dos.
  'patient_ledgers.patientId': 'resumen recalculado al final',
  // Procedencia de la importación (DX-107/DX-262): qué fila creó o rellenó a
  // qué paciente. El absorbido sigue siendo el que la fila creó.
  'patient_import_rows.patientId': 'procedencia del lote',
  'patient_import_balance_rows.patientId': 'procedencia de la hoja de saldos',
  // «No es duplicado»: la fusión pasa al conservado las del absorbido.
  'patient_duplicate_dismissals.patientAId': 'reapuntado aparte',
  'patient_duplicate_dismissals.patientBId': 'reapuntado aparte',
  // Fusiones anteriores: la fusión reapunta las que apuntaban al absorbido.
  'patients.mergedIntoId': 'reapuntado aparte',
  // DX-172: quién lo recomendó. Los recomendados del absorbido pasan al
  // conservado (y el conservado nunca queda recomendado por sí mismo).
  'patients.referredByPatientId': 'reapuntado aparte',
};

const SAME_PAIR_ALLOWED_CHANGES: Record<string, string[]> = {
  medical_history_versions: ['version'],
  recall_contacts: ['recallId'],
  patient_responsible_parties: ['responsiblePatientId'],
};

let demoTenant: string;
let demoAdmin: string;
let foreignTenant: string;
let foreignPatient: string;

function ctx(tenantId = demoTenant, userId = demoAdmin): AuditRequestContext {
  return {
    tenantId,
    locationId: null,
    actor: { userId, role: 'ADMIN' },
    requestId: 'int-dx266',
    ip: '203.0.113.66',
    userAgent: 'int-dx266',
  };
}

function inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(tenantId, fn);
}

/** `fn` como la app con la clínica fijada; siempre se deshace. */
async function rolledBack(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  await expect(
    prisma.runWithTenant(tenantId, async (tx) => {
      await fn(tx);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
}

async function mergeTables(): Promise<string[]> {
  const [{ tables }] = await owner.$queryRaw<{ tables: string[] }[]>`
    SELECT dx_patient_merge_tables() AS tables`;
  return tables;
}

async function livePatients(tenantId: string): Promise<string[]> {
  const rows = await owner.patient.findMany({
    where: { tenantId, deletedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Entradas de la cartera de los pacientes (por plan y saldo migrado). */
async function ledgerEntries(
  tx: Prisma.TransactionClient,
  patientIds: string[],
): Promise<{ plans: unknown; openings: unknown }> {
  const [row] = await tx.$queryRaw<{ plans: unknown; openings: unknown }[]>`
    SELECT
      COALESCE((SELECT jsonb_agg(e ORDER BY e->>0)
                  FROM patient_ledgers l, jsonb_array_elements(l.ledger->'plans') e
                 WHERE l."patientId" = ANY (${patientIds}::uuid[])), '[]') AS plans,
      COALESCE((SELECT jsonb_agg(e ORDER BY e->>0)
                  FROM patient_ledgers l, jsonb_array_elements(l.ledger->'openings') e
                 WHERE l."patientId" = ANY (${patientIds}::uuid[])), '[]') AS openings`;
  return row;
}

/** Saldo por moneda de los pacientes, de su cartera (planes y saldos migrados). */
async function balanceByCurrency(
  tx: Prisma.TransactionClient,
  patientIds: string[],
): Promise<Record<string, string>> {
  const rows = await tx.$queryRaw<{ currency: string; balance: string }[]>`
    SELECT x.currency, sum(x.balance)::text AS balance FROM (
      SELECT e->>2 AS currency,
             COALESCE((e->>5)::numeric, 0) - COALESCE((e->>6)::numeric, 0) - COALESCE((e->>8)::numeric, 0) AS balance
        FROM patient_ledgers l, jsonb_array_elements(l.ledger->'plans') e
       WHERE l."patientId" = ANY (${patientIds}::uuid[])
      UNION ALL
      SELECT e->>1, (e->>2)::numeric - COALESCE((e->>5)::numeric, 0)
        FROM patient_ledgers l, jsonb_array_elements(l.ledger->'openings') e
       WHERE l."patientId" = ANY (${patientIds}::uuid[])
    ) x GROUP BY 1 ORDER BY 1`;
  return Object.fromEntries(rows.map((r) => [r.currency, r.balance]));
}

/** Filas de las tablas inalterables de los dos, sin sus columnas de paciente. */
async function immutableRows(
  tx: Prisma.TransactionClient,
  tables: string[],
  patientIds: string[],
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  for (const table of tables) {
    const strip = ['patientId', ...(SAME_PAIR_ALLOWED_CHANGES[table] ?? [])];
    const rows = await tx.$queryRawUnsafe<{ id: string; body: unknown }[]>(
      `SELECT t."id"::text AS id, to_jsonb(t) - $2::text[] AS body
         FROM public."${table}" t WHERE t."patientId" = ANY ($1::uuid[])`,
      patientIds,
      strip,
    );
    for (const r of rows) out.set(`${table}:${r.id}`, r.body);
  }
  return out;
}

async function leftovers(
  tx: Prisma.TransactionClient,
  tables: string[],
  patientId: string,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of tables) {
    const [{ n }] = await tx.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM public."${table}" WHERE "patientId" = $1::uuid`,
      patientId,
    );
    if (n > 0) out[table] = n;
  }
  return out;
}

beforeAll(async () => {
  await purgeDemoTenants(owner);
  const seeded = await seedDemo({ quiet: true });
  demoTenant = seeded.tenantId;
  const admin = await owner.clinicMembership.findFirstOrThrow({
    where: { tenantId: demoTenant, role: 'ADMIN' },
    select: { userId: true },
  });
  demoAdmin = admin.userId;
  const foreign = await owner.tenant.create({
    data: {
      name: 'Ajena DX-266',
      subdomain: `dx266-ajena-${randomUUID().slice(0, 8)}`,
    },
  });
  foreignTenant = foreign.id;
  foreignPatient = (
    await owner.patient.create({
      data: { tenantId: foreignTenant, firstName: 'Ana', lastName: 'Ajena' },
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await purgeTenants(owner, [foreignTenant]);
  await purgeDemoTenants(owner);
  await owner.$disconnect();
  await prisma.$disconnect();
});

describe('DX-266 · catálogo: la fusión trata toda columna de paciente', () => {
  it('cada columna con FK a pacientes (o «patientId») está en dx_patient_merge_tables() o en las exclusiones razonadas', async () => {
    const catalog = await owner.$queryRaw<{ ref: string }[]>`
      SELECT DISTINCT cl.relname || '.' || a.attname AS ref
        FROM pg_class cl
        JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
        JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE cl.relkind IN ('r', 'p') AND NOT cl.relispartition
         AND (a.attname IN ('patientId', 'responsiblePatientId')
              OR EXISTS (
                SELECT 1 FROM pg_constraint c
                 CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(con, conf)
                  JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.conf
                 WHERE c.contype = 'f' AND c.conrelid = cl.oid
                   AND c.confrelid = 'public.patients'::regclass
                   AND fa.attname = 'id' AND k.con = a.attnum))
       ORDER BY 1`;
    // Si falla: una tabla nueva apunta a un paciente. Decide qué hace la
    // fusión con ella (moverla: dx_patient_merge_tables(), su categoría en
    // MERGE_TABLE_CATEGORY y la puerta en sus guardas; o no: NOT_MOVED con
    // el motivo).
    expect(catalog.map((r) => r.ref).sort()).toEqual(
      [...(await mergeTables()), ...Object.keys(NOT_MOVED)].sort(),
    );
  });

  it('cada tabla que se mueve tiene su categoría en la vista previa, y no sobra ninguna', async () => {
    const tables = [
      ...new Set((await mergeTables()).map((e) => e.split('.')[0])),
    ].sort();
    expect(Object.keys(MERGE_TABLE_CATEGORY).sort()).toEqual(tables);
  });

  it('cada guarda BEFORE UPDATE de una tabla que se mueve abre la puerta de la fusión', async () => {
    const tables = [
      ...new Set((await mergeTables()).map((e) => e.split('.')[0])),
    ];
    const guards = await owner.$queryRaw<{ trigger: string; gated: boolean }[]>`
      SELECT c.relname || '.' || t.tgname AS trigger,
             p.prosrc LIKE '%dx_patient_merge_gate%' AS gated
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal AND c.relname = ANY (${tables})
         AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16
       ORDER BY 1`;
    expect(guards.length).toBeGreaterThan(50);
    // Si falla: una guarda nueva (o reescrita) de una tabla con paciente no
    // deja pasar la reasignación de la fusión (ver la migración de DX-266).
    expect(guards.filter((g) => !g.gated).map((g) => g.trigger)).toEqual([]);
  });
});

describe('DX-266 · fusionar las parejas de la demo', () => {
  it('cada pareja consecutiva: nada queda en el absorbido, la HC no cambia y la cartera y el saldo son los mismos', async () => {
    const entries = await mergeTables();
    const tables = [...new Set(entries.map((e) => e.split('.')[0]))].sort();
    const immutable = tables.filter((t) =>
      (NO_APP_UPDATE_DELETE as readonly string[]).includes(t),
    );
    // Lo clínico inalterable que la demo siembra, como mínimo.
    expect(immutable).toEqual(
      expect.arrayContaining([
        'tooth_records',
        'clinical_entry_addenda',
        'medical_history_versions',
        'patient_consents',
        'data_processing_consents',
        'patient_dentition_events',
      ]),
    );
    const ids = await livePatients(demoTenant);
    expect(ids.length).toBeGreaterThan(20);
    let merged = 0;
    let blocked = 0;
    for (let i = 0; i + 1 < ids.length; i++) {
      const [absorbed, kept] = [ids[i], ids[i + 1]];
      await rolledBack(demoTenant, async (tx) => {
        const beforeLedger = await ledgerEntries(tx, [absorbed, kept]);
        const beforeBalance = await balanceByCurrency(tx, [absorbed, kept]);
        const beforeRows = await immutableRows(tx, immutable, [absorbed, kept]);
        await tx.$executeRaw`SAVEPOINT dx266`;
        try {
          await tx.$queryRaw`SELECT dx_merge_patients(${absorbed}::uuid, ${kept}::uuid, ${demoAdmin}::uuid)`;
        } catch (error) {
          // Lo que no se puede fusionar lo dice con su código (DX266_*).
          expect(String(error)).toMatch(/DX266_[A-Z_]+/);
          await tx.$executeRaw`ROLLBACK TO SAVEPOINT dx266`;
          blocked++;
          return;
        }
        merged++;
        expect(await ledgerEntries(tx, [kept])).toEqual(beforeLedger);
        expect(await ledgerEntries(tx, [absorbed])).toEqual({
          plans: [],
          openings: [],
        });
        expect(await balanceByCurrency(tx, [kept])).toEqual(beforeBalance);
        // Lo único que puede quedar: el vínculo de responsable entre los dos.
        const left = await leftovers(tx, tables, absorbed);
        delete left.patient_responsible_parties;
        expect(left).toEqual({});
        const afterRows = await immutableRows(tx, immutable, [kept]);
        expect(afterRows).toEqual(beforeRows);
        const [after] = await tx.$queryRaw<
          { deletedAt: Date | null; mergedIntoId: string | null }[]
        >`SELECT "deletedAt", "mergedIntoId" FROM "patients" WHERE "id" = ${absorbed}::uuid`;
        expect(after.deletedAt).not.toBeNull();
        expect(after.mergedIntoId).toBe(kept);
      });
    }
    // La demo tiene de las dos: parejas que se fusionan y parejas con citas a
    // la misma hora (bloqueo).
    expect(merged).toBeGreaterThan(10);
    expect(merged + blocked).toBe(ids.length - 1);
  }, 180_000);

  it('todas en una: la anamnesis se renumera por fecha (1…n), el saldo total de la clínica no cambia y las fusiones previas apuntan al último', async () => {
    const ids = await livePatients(demoTenant);
    const versions = await owner.medicalHistoryVersion.count({
      where: { tenantId: demoTenant, deletedAt: null },
    });
    await rolledBack(demoTenant, async (tx) => {
      const before = await balanceByCurrency(tx, ids);
      // Encadenadas: a → b, luego b → c…: la última recibe todo.
      let kept = ids[0];
      const absorbedOnes: string[] = [];
      for (const next of ids.slice(1)) {
        await tx.$executeRaw`SAVEPOINT chain`;
        try {
          await tx.$queryRaw`SELECT dx_merge_patients(${kept}::uuid, ${next}::uuid, ${demoAdmin}::uuid)`;
          absorbedOnes.push(kept);
          kept = next;
        } catch {
          await tx.$executeRaw`ROLLBACK TO SAVEPOINT chain`;
        }
      }
      expect(absorbedOnes.length).toBeGreaterThan(5);
      expect(await balanceByCurrency(tx, ids)).toEqual(before);
      const pointers = await tx.$queryRaw<{ target: string }[]>`
        SELECT DISTINCT "mergedIntoId"::text AS target FROM "patients"
         WHERE "id" = ANY (${absorbedOnes}::uuid[])`;
      expect(pointers).toEqual([{ target: kept }]);
      const numbers = await tx.$queryRaw<{ version: number }[]>`
        SELECT "version" FROM "medical_history_versions"
         WHERE "patientId" = ${kept}::uuid AND "deletedAt" IS NULL
         ORDER BY "createdAt", "version"`;
      expect(numbers.map((n) => n.version)).toEqual(
        numbers.map((_, i) => i + 1),
      );
      const [{ total }] = await tx.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM "medical_history_versions" WHERE "deletedAt" IS NULL`;
      expect(total).toBe(versions);
    });
  }, 120_000);
});

describe('DX-266 · inmutabilidad: solo la fusión reasigna y solo el paciente', () => {
  async function toothRecordOf(): Promise<{ id: string; patientId: string }> {
    return owner.toothRecord.findFirstOrThrow({
      where: { tenantId: demoTenant },
      select: { id: true, patientId: true },
    });
  }

  it('la app no puede reasignar una tabla append-only aunque fije la variable de la fusión: permission denied', async () => {
    const record = await toothRecordOf();
    const [other] = (await livePatients(demoTenant)).filter(
      (id) => id !== record.patientId,
    );
    await expect(
      prisma.runWithTenant(demoTenant, async (tx) => {
        await tx.$executeRaw`SELECT set_config('dentalix.patient_merge', ${`${demoTenant}:${record.patientId}:${other}`}, true)`;
        await tx.$executeRaw`UPDATE "tooth_records" SET "patientId" = ${other}::uuid WHERE "id" = ${record.id}::uuid`;
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('la app, con UPDATE en la tabla (evoluciones, documentos), tampoco: la puerta no se abre para dentalix_app', async () => {
    const entry = await owner.clinicalEntry.findFirstOrThrow({
      where: { tenantId: demoTenant },
      select: { id: true, patientId: true },
    });
    const [other] = (await livePatients(demoTenant)).filter(
      (id) => id !== entry.patientId,
    );
    await expect(
      prisma.runWithTenant(demoTenant, async (tx) => {
        await tx.$executeRaw`SELECT set_config('dentalix.patient_merge', ${`${demoTenant}:${entry.patientId}:${other}`}, true)`;
        await tx.$executeRaw`UPDATE "clinical_entries" SET "patientId" = ${other}::uuid WHERE "id" = ${entry.id}::uuid`;
      }),
    ).rejects.toThrow(/inalterable|violates foreign key/);
    expect(
      (await owner.clinicalEntry.findUniqueOrThrow({ where: { id: entry.id } }))
        .patientId,
    ).toBe(entry.patientId);
  });

  it('ni el dueño dentro de una «fusión» cambia el contenido: la puerta solo deja pasar el paciente', async () => {
    const record = await toothRecordOf();
    const [other] = (await livePatients(demoTenant)).filter(
      (id) => id !== record.patientId,
    );
    await expect(
      owner.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('dentalix.patient_merge', ${`${demoTenant}:${record.patientId}:${other}`}, true)`;
        await tx.$executeRaw`UPDATE "tooth_records" SET "notes" = 'editado' WHERE "id" = ${record.id}::uuid`;
      }),
    ).rejects.toThrow(/append-only/);
    // Y sin la variable, ni siquiera el paciente.
    await expect(
      owner.$executeRaw`UPDATE "tooth_records" SET "patientId" = ${other}::uuid WHERE "id" = ${record.id}::uuid`,
    ).rejects.toThrow(/append-only/);
  });
});

describe('DX-266 · nunca entre clínicas (RLS)', () => {
  it('con la clínica de A en el contexto, el paciente de otra clínica no existe: DX266_NOT_FOUND y nada cambia', async () => {
    const [demoPatient] = await livePatients(demoTenant);
    for (const [absorbed, kept] of [
      [foreignPatient, demoPatient],
      [demoPatient, foreignPatient],
    ]) {
      await expect(
        prisma.runWithTenant(
          demoTenant,
          (tx) =>
            tx.$queryRaw`SELECT dx_merge_patients(${absorbed}::uuid, ${kept}::uuid, ${demoAdmin}::uuid)`,
        ),
      ).rejects.toThrow(/DX266_NOT_FOUND/);
      // Y desde la otra clínica, igual.
      await expect(
        prisma.runWithTenant(
          foreignTenant,
          (tx) =>
            tx.$queryRaw`SELECT dx_merge_patients(${absorbed}::uuid, ${kept}::uuid, ${demoAdmin}::uuid)`,
        ),
      ).rejects.toThrow(/DX266_NOT_FOUND/);
    }
    await expect(
      inTenant(demoTenant, () =>
        repo.merge(
          { keptId: demoPatient, absorbedId: foreignPatient, choices: {} },
          new Date(),
          ctx(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    const untouched = await owner.patient.findMany({
      where: { id: { in: [demoPatient, foreignPatient] } },
      select: { deletedAt: true, mergedIntoId: true },
    });
    expect(untouched).toEqual([
      { deletedAt: null, mergedIntoId: null },
      { deletedAt: null, mergedIntoId: null },
    ]);
  });

  it('DX-172: los recomendados del absorbido pasan al conservado, nadie queda recomendado por sí mismo y, sin fuente, el conservado hereda la del absorbido', async () => {
    await rolledBack(demoTenant, async (tx) => {
      await tx.$queryRaw`SELECT dx_patient_sources_ensure(${demoTenant}::uuid)`;
      const sources = await tx.patientSource.findMany({
        where: { tenantId: demoTenant },
        select: { id: true, systemKey: true },
      });
      const key = (k: string) => sources.find((s) => s.systemKey === k)!.id;
      const referral = key('PATIENT_REFERRAL');
      const instagram = key('INSTAGRAM');
      const make = (
        lastName: string,
        data: Partial<{
          sourceId: string;
          referredByPatientId: string;
          referredByName: string;
        }> = {},
      ) =>
        tx.patient
          .create({
            data: {
              tenantId: demoTenant,
              firstName: 'DX172',
              lastName,
              ...data,
            },
            select: { id: true },
          })
          .then((p) => p.id);
      const read = (id: string) =>
        tx.patient.findUniqueOrThrow({
          where: { id },
          select: {
            sourceId: true,
            referredByPatientId: true,
            referredByName: true,
          },
        });

      // 1. El conservado ya tiene fuente: la conserva; su vínculo con el
      //    absorbido (que lo recomendó) se vacía; el tercero pasa al conservado.
      const absorbed = await make('Absorbido', { sourceId: instagram });
      const kept = await make('Conservado', {
        sourceId: referral,
        referredByPatientId: absorbed,
      });
      const third = await make('Tercero', {
        sourceId: referral,
        referredByPatientId: absorbed,
      });
      const [{ result }] = await tx.$queryRaw<
        { result: { resolved: Record<string, number> } }[]
      >`
        SELECT dx_merge_patients(${absorbed}::uuid, ${kept}::uuid, ${demoAdmin}::uuid) AS result`;
      expect(result.resolved).toMatchObject({
        referralsMoved: 1,
        selfReferralCleared: 1,
      });
      expect(await read(kept)).toEqual({
        sourceId: referral,
        referredByPatientId: null,
        referredByName: null,
      });
      expect((await read(third)).referredByPatientId).toBe(kept);

      // 2. El conservado sin fuente hereda la del absorbido (con su referente).
      const referrer = await make('Referente');
      const absorbed2 = await make('Absorbido2', {
        sourceId: referral,
        referredByPatientId: referrer,
      });
      const kept2 = await make('Conservado2');
      await tx.$queryRaw`SELECT dx_merge_patients(${absorbed2}::uuid, ${kept2}::uuid, ${demoAdmin}::uuid)`;
      expect(await read(kept2)).toEqual({
        sourceId: referral,
        referredByPatientId: referrer,
        referredByName: null,
      });

      // 3. …salvo que el referente heredado sea el propio conservado.
      const kept3 = await make('Conservado3');
      const absorbed3 = await make('Absorbido3', {
        sourceId: referral,
        referredByPatientId: kept3,
      });
      await tx.$queryRaw`SELECT dx_merge_patients(${absorbed3}::uuid, ${kept3}::uuid, ${demoAdmin}::uuid)`;
      expect(await read(kept3)).toEqual({
        sourceId: referral,
        referredByPatientId: null,
        referredByName: null,
      });
    });
  });

  it('sin clínica en la sesión la función se niega', async () => {
    const [a, b] = await livePatients(demoTenant);
    const app = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    try {
      await expect(
        app.$queryRaw`SELECT dx_merge_patients(${a}::uuid, ${b}::uuid, ${demoAdmin}::uuid)`,
      ).rejects.toThrow(/DX266_NO_TENANT/);
    } finally {
      await app.$disconnect();
    }
  });
});

describe('DX-266 · concurrencia', () => {
  /** Dos pacientes nuevos, sin nada, para fusionar de verdad (con COMMIT). */
  async function freshPair(): Promise<[string, string]> {
    const make = async (first: string) =>
      (
        await owner.patient.create({
          data: {
            tenantId: demoTenant,
            firstName: first,
            lastName: 'Concurrente',
          },
        })
      ).id;
    return [await make('Uno'), await make('Dos')];
  }

  it('dos fusiones a la vez del mismo absorbido: una gana, la otra responde 409 y el absorbido apunta a un solo paciente', async () => {
    const [absorbed, keptA] = await freshPair();
    const [keptB] = await freshPair();
    // Retiene al absorbido para que las dos fusiones esperen a la vez.
    const held = await holdLock(
      owner,
      (tx) =>
        tx.$queryRaw`SELECT 1 FROM "patients" WHERE "id" = ${absorbed}::uuid FOR UPDATE`,
    );
    const first = settle(
      inTenant(demoTenant, () =>
        repo.merge(
          { keptId: keptA, absorbedId: absorbed, choices: {} },
          new Date(),
          ctx(),
        ),
      ),
    );
    const second = settle(
      inTenant(demoTenant, () =>
        repo.merge(
          { keptId: keptB, absorbedId: absorbed, choices: {} },
          new Date(),
          ctx(),
        ),
      ),
    );
    await waitForLockWaiters(owner, [held.pid], 2);
    held.release();
    await held.done;
    const outcomes = await Promise.all([first, second]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const failed = outcomes.find((o) => o.status === 'rejected');
    expect(
      failed && failed.status === 'rejected' && failed.reason,
    ).toBeInstanceOf(ConflictException);
    const row = await owner.patient.findUniqueOrThrow({
      where: { id: absorbed },
      select: { mergedIntoId: true, deletedAt: true },
    });
    expect([keptA, keptB]).toContain(row.mergedIntoId);
    expect(row.deletedAt).not.toBeNull();
    const events = await owner.auditEvent.count({
      where: {
        tenantId: demoTenant,
        resourceId: absorbed,
        metadata: { path: ['reason'], equals: 'PATIENT_MERGED' },
      },
    });
    expect(events).toBe(1);
  });

  it('cruzadas (A → B y B → A a la vez): sin interbloqueo, una gana y la otra 409', async () => {
    const [a, b] = await freshPair();
    const held = await holdLock(
      owner,
      (tx) =>
        tx.$queryRaw`SELECT 1 FROM "patients" WHERE "id" IN (${a}::uuid, ${b}::uuid) ORDER BY "id" FOR UPDATE`,
    );
    const ab = settle(
      inTenant(demoTenant, () =>
        repo.merge(
          { keptId: b, absorbedId: a, choices: {} },
          new Date(),
          ctx(),
        ),
      ),
    );
    const ba = settle(
      inTenant(demoTenant, () =>
        repo.merge(
          { keptId: a, absorbedId: b, choices: {} },
          new Date(),
          ctx(),
        ),
      ),
    );
    await waitForLockWaiters(owner, [held.pid], 2);
    held.release();
    await held.done;
    const outcomes = await Promise.all([ab, ba]);
    expect(outcomes.map((o) => o.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const rows = await owner.patient.findMany({
      where: { id: { in: [a, b] } },
      select: { id: true, mergedIntoId: true },
    });
    // Exactamente uno absorbido, apuntando al otro (nunca un ciclo).
    expect(rows.filter((r) => r.mergedIntoId !== null)).toHaveLength(1);
    const absorbed = rows.find((r) => r.mergedIntoId !== null)!;
    expect(absorbed.mergedIntoId).toBe(
      rows.find((r) => r.id !== absorbed.id)!.id,
    );
  });
});

describe('DX-266 · «uno por paciente» y bloqueos', () => {
  it('lo que impide fusionar lo enseña la vista previa y lo rechaza la fusión con su código', async () => {
    // Dos pacientes de la demo con citas vivas a la misma hora.
    const [pair] = await owner.$queryRaw<{ a: string; b: string }[]>`
      SELECT x."patientId" AS a, y."patientId" AS b
        FROM appointments x
        JOIN appointments y
          ON y."tenantId" = x."tenantId" AND y."patientId" > x."patientId"
         AND y."deletedAt" IS NULL AND y."status" <> 'CANCELLED'
         AND tsrange(x."start", x."end") && tsrange(y."start", y."end")
       WHERE x."tenantId" = ${demoTenant}::uuid
         AND x."deletedAt" IS NULL AND x."status" <> 'CANCELLED'
       ORDER BY 1, 2
       LIMIT 1`;
    expect(pair).toBeDefined();
    const found: [string, string] = [pair.a, pair.b];
    const [absorbed, kept] = found;
    const preview = await inTenant(demoTenant, () =>
      repo.preview(kept, absorbed, new Date(), ctx()),
    );
    expect(preview?.blockers).toContain('DX266_OVERLAPPING_APPOINTMENTS');
    await expect(
      inTenant(demoTenant, () =>
        repo.merge(
          { keptId: kept, absorbedId: absorbed, choices: {} },
          new Date(),
          ctx(),
        ),
      ),
    ).rejects.toMatchObject({
      response: { code: 'MERGE_OVERLAPPING_APPOINTMENTS' },
    });
    expect(
      (await owner.patient.findUniqueOrThrow({ where: { id: absorbed } }))
        .deletedAt,
    ).toBeNull();
  });

  it('coberturas principales, lista de espera y recalls del mismo tipo: gana el conservado sin perder nada', async () => {
    // Una pareja de la demo en la que los dos tienen recall del mismo tipo.
    const pairs = await owner.$queryRaw<{ a: string; b: string }[]>`
      SELECT x."patientId" AS a, y."patientId" AS b
        FROM patient_recalls x
        JOIN patient_recalls y ON y."tenantId" = x."tenantId"
         AND y."recallTypeId" = x."recallTypeId" AND y."patientId" > x."patientId"
       WHERE x."tenantId" = ${demoTenant}::uuid
       ORDER BY 1, 2`;
    let checked = false;
    for (const { a, b } of pairs) {
      const [{ blockers }] = await prisma.runWithTenant(
        demoTenant,
        (tx) =>
          tx.$queryRaw<{ blockers: string[] }[]>`
          SELECT dx_patient_merge_blockers(${a}::uuid, ${b}::uuid) AS blockers`,
      );
      if (blockers.length > 0) continue;
      await rolledBack(demoTenant, async (tx) => {
        const recallsBefore = await tx.patientRecall.count({
          where: { patientId: { in: [a, b] } },
        });
        const contactsBefore = await tx.recallContact.count({
          where: { patientId: { in: [a, b] } },
        });
        const [{ result }] = await tx.$queryRaw<
          {
            result: {
              moved: Record<string, number>;
              resolved: Record<string, number>;
            };
          }[]
        >`SELECT dx_merge_patients(${a}::uuid, ${b}::uuid, ${demoAdmin}::uuid) AS result`;
        expect(result.resolved.recallsMerged).toBeGreaterThan(0);
        expect(await tx.patientRecall.count({ where: { patientId: b } })).toBe(
          recallsBefore - result.resolved.recallsMerged,
        );
        expect(await tx.recallContact.count({ where: { patientId: b } })).toBe(
          contactsBefore,
        );
        expect(
          await tx.patientCoverage.count({
            where: { patientId: b, isPrimary: true, deletedAt: null },
          }),
        ).toBeLessThanOrEqual(1);
        expect(
          await tx.appointmentWaitlistEntry.count({
            where: { patientId: b, status: 'OPEN' },
          }),
        ).toBeLessThanOrEqual(1);
      });
      checked = true;
      break;
    }
    expect(checked).toBe(true);
  });
});
