import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPatientRepository } from '../src/modules/patients/infrastructure/repositories/prisma-patient.repository';
import { PrismaAcquisitionRepository } from '../src/modules/reports/infrastructure/prisma-acquisition.repository';
import {
  GetAcquisitionUseCase,
  type AcquisitionReport,
} from '../src/modules/reports/application/use-cases/get-acquisition.use-case';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import { ACQUISITION_MESSAGES } from '../src/modules/patients/domain/patient-acquisition';
import { purgeTenants } from './support/tenant-purge';
import { ReportSeeder } from './support/reports-fixtures';

// DX-172 contra Postgres: el catálogo «¿Cómo nos conoció?» (RLS FORCE, sin
// DELETE para la app, siembra idempotente), las FK compuestas y los CHECK de
// patients, la auditoría de la captación, la supresión parcial y el informe
// de captación (cifras y plan). La app es DATABASE_URL (dentalix_app, RLS
// FORZADA); `raw` (DIRECT_URL, owner) solo siembra y comprueba.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const context = new TenantContextService();
const prisma = new PrismaService(context);
const patients = new PrismaPatientRepository(prisma, context, {
  platformMinYears: 15,
});
const acquisitionRepo = new PrismaAcquisitionRepository(prisma, context);
const report = new GetAcquisitionUseCase(acquisitionRepo);

interface Clinic {
  tenantId: string;
  seed: ReportSeeder;
  main: string;
  norte: string;
  providerId: string;
  adminId: string;
  sources: Record<string, string>;
}

const tenants: string[] = [];

async function clinic(name: string): Promise<Clinic> {
  const subdomain = `dx172-${name}-${randomUUID().slice(0, 8)}`;
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
    select: { id: true },
  });
  tenants.push(tenant.id);
  const seed = new ReportSeeder(raw, tenant.id);
  const main = await seed.location('Sede principal');
  const norte = await seed.location('Sede Norte');
  const dentist = await seed.dentist();
  await prisma.runWithTenant(
    tenant.id,
    (tx) => tx.$queryRaw`SELECT dx_patient_sources_ensure(${tenant.id}::uuid)`,
  );
  const rows = await raw.patientSource.findMany({
    where: { tenantId: tenant.id },
    select: { id: true, systemKey: true },
  });
  return {
    tenantId: tenant.id,
    seed,
    main,
    norte,
    providerId: dentist.userId,
    adminId: dentist.userId,
    sources: Object.fromEntries(rows.map((r) => [r.systemKey!, r.id])),
  };
}

function ctx(c: Clinic): AuditRequestContext {
  return {
    tenantId: c.tenantId,
    locationId: null,
    actor: { userId: c.adminId, role: 'ADMIN' },
    requestId: 'int-dx172',
    ip: '203.0.113.72',
    userAgent: 'int-dx172',
  };
}

/** Un paciente sembrado (owner) con su captación y su fecha de alta. */
async function patient(
  c: Clinic,
  lastName: string,
  data: {
    sourceId?: string;
    referredByPatientId?: string;
    createdAt?: Date;
  } = {},
): Promise<string> {
  const row = await raw.patient.create({
    data: { tenantId: c.tenantId, firstName: 'Paciente', lastName, ...data },
    select: { id: true },
  });
  return row.id;
}

/** Su primera cita (la sede de captación): días fijos a mediodía de Caracas. */
let visits = 0;
async function firstVisit(c: Clinic, patientId: string, locationId: string) {
  const start = new Date(Date.UTC(2026, 9, 1 + visits++, 16, 0));
  await raw.appointment.create({
    data: {
      tenantId: c.tenantId,
      locationId,
      patientId,
      providerId: c.providerId,
      start,
      end: new Date(start.getTime() + 30 * 60_000),
    },
  });
}

async function pay(
  c: Clinic,
  patientId: string,
  amount: number,
  input: {
    currency?: string;
    locationId?: string;
    paidAt?: string;
    voided?: boolean;
  } = {},
): Promise<void> {
  // Un abono va a un plan del paciente (payments_target_check).
  const currency = input.currency ?? 'VES';
  const plan =
    (await raw.treatmentPlan.findFirst({
      where: { tenantId: c.tenantId, patientId, currency },
      select: { id: true },
    })) ??
    (await raw.treatmentPlan.create({
      data: { tenantId: c.tenantId, patientId, currency },
      select: { id: true },
    }));
  const created = await raw.payment.create({
    data: {
      treatmentPlanId: plan.id,
      tenantId: c.tenantId,
      locationId: input.locationId ?? c.main,
      patientId,
      amount,
      currency: input.currency ?? 'VES',
      paidAt: new Date(input.paidAt ?? '2026-10-20T16:00:00.000Z'),
      method: 'CASH',
    },
    select: { id: true },
  });
  if (input.voided) {
    await raw.payment.update({
      where: { id: created.id },
      data: {
        deletedAt: new Date(),
        voidedAt: new Date(),
        voidedById: c.adminId,
        voidReason: 'Cobro duplicado',
      },
    });
  }
}

const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };
const IN_OCTOBER = new Date('2026-10-10T16:00:00.000Z');

function row(r: AcquisitionReport, name: string) {
  const found = r.rows.find((x) => x.name === name);
  if (!found) throw new Error(`sin fila ${name}`);
  return found;
}

afterAll(async () => {
  await purgeTenants(raw, tenants);
  await raw.$disconnect();
  await prisma.$disconnect();
});

describe('DX-172 · catálogo de fuentes en la BD', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    a = await clinic('a');
    b = await clinic('b');
  }, 60_000);

  it('patient_sources: RLS ENABLE + FORCE y sin DELETE ni TRUNCATE para la app', async () => {
    const [flags] = await raw.$queryRaw<
      { rls: boolean; force: boolean }[]
    >`SELECT relrowsecurity AS rls, relforcerowsecurity AS force
        FROM pg_class WHERE oid = 'public.patient_sources'::regclass`;
    expect(flags).toEqual({ rls: true, force: true });
    const [grants] = await raw.$queryRaw<{ del: boolean; trunc: boolean }[]>`
      SELECT has_table_privilege('dentalix_app', 'public.patient_sources', 'DELETE') AS del,
             has_table_privilege('dentalix_app', 'public.patient_sources', 'TRUNCATE') AS trunc`;
    expect(grants).toEqual({ del: false, trunc: false });
  });

  it('cada clínica ve solo sus fuentes (las 9 sembradas, en español neutro)', async () => {
    const seen = await prisma.runWithTenant(b.tenantId, (tx) =>
      tx.patientSource.findMany({
        orderBy: { sortOrder: 'asc' },
        select: { tenantId: true, name: true },
      }),
    );
    expect(seen.every((s) => s.tenantId === b.tenantId)).toBe(true);
    expect(seen.map((s) => s.name)).toEqual([
      'Recomendación de paciente',
      'Instagram',
      'Facebook',
      'Google',
      'Marketplace de reservas',
      'Convenio/empresa',
      'Profesional externo',
      'Paso por la sede',
      'Otro',
    ]);
  });

  it('la siembra es idempotente y dos a la vez no duplican nada', async () => {
    const fresh = await raw.tenant.create({
      data: {
        name: 'dx172-vacia',
        subdomain: `dx172-vacia-${randomUUID().slice(0, 8)}`,
      },
      select: { id: true },
    });
    tenants.push(fresh.id);
    const ensure = () =>
      prisma.runWithTenant(
        fresh.id,
        (tx) =>
          tx.$queryRaw<
            { seeded: boolean }[]
          >`SELECT dx_patient_sources_ensure(${fresh.id}::uuid) AS seeded`,
      );
    await Promise.all([ensure(), ensure()]);
    const [again] = await ensure();
    expect(again.seeded).toBe(false);
    expect(
      await raw.patientSource.count({ where: { tenantId: fresh.id } }),
    ).toBe(9);
  });

  it('FK compuestas: ni la fuente ni el referente de otra clínica, ni a sí mismo', async () => {
    const ana = await patient(a, 'Ana');
    const luis = await patient(b, 'Luis');
    await expect(
      raw.patient.update({
        where: { id: luis },
        data: { sourceId: a.sources.INSTAGRAM },
      }),
    ).rejects.toThrow(/patients_source_fkey|Foreign key/i);
    await expect(
      raw.patient.update({
        where: { id: luis },
        data: {
          sourceId: b.sources.PATIENT_REFERRAL,
          referredByPatientId: ana,
        },
      }),
    ).rejects.toThrow(/patients_referred_by_fkey|Foreign key/i);
    await expect(
      raw.$executeRaw`UPDATE "patients" SET "sourceId" = ${a.sources.PATIENT_REFERRAL}::uuid,
                      "referredByPatientId" = "id" WHERE "id" = ${ana}::uuid`,
    ).rejects.toThrow(/patients_referred_by_self_check/);
    await expect(
      raw.$executeRaw`UPDATE "patients" SET "referredByName" = 'Dr. Luis Pérez' WHERE "id" = ${ana}::uuid`,
    ).rejects.toThrow(/patients_referral_needs_source_check/);
    await expect(
      raw.$executeRaw`UPDATE "patients" SET "sourceId" = ${a.sources.EXTERNAL_PROFESSIONAL}::uuid,
                      "referredByName" = '  Dr. Luis  ' WHERE "id" = ${ana}::uuid`,
    ).rejects.toThrow(/patients_referred_by_name_check/);
  });

  it('la app no puede dar de alta con el referente de otra clínica (400 del repositorio)', async () => {
    const ana = await patient(a, 'Ana Referente');
    await expect(
      context.run(b.tenantId, () =>
        patients.create({
          firstName: 'Luis',
          lastName: 'Ajeno',
          docType: 'OTHER',
          docTypeLabel: null,
          sex: 'UNSPECIFIED',
          acquisition: {
            sourceId: b.sources.PATIENT_REFERRAL,
            referredByPatientId: ana,
          },
        }),
      ),
    ).rejects.toThrow(
      new BadRequestException(ACQUISITION_MESSAGES.referrerNotFound),
    );
  });

  it('la edición deja un evento con antes y después (la fuente por nombre; el profesional, oculto)', async () => {
    const p = await patient(a, 'Auditada', { sourceId: a.sources.INSTAGRAM });
    await context.run(a.tenantId, () =>
      patients.update(
        p,
        {
          sourceId: a.sources.EXTERNAL_PROFESSIONAL,
          referredByName: 'Dra. Carmen Rojas',
        },
        ctx(a),
      ),
    );
    const events = await raw.auditEvent.findMany({
      where: { tenantId: a.tenantId, resourceId: p, action: 'UPDATE' },
      select: { resourceType: true, patientId: true, metadata: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      resourceType: 'PATIENT',
      patientId: p,
      metadata: {
        reason: 'PATIENT_ACQUISITION_CHANGED',
        changedFields: ['referredByName', 'source', 'sourceId'],
        configChange: {
          before: { source: 'Instagram', sourceId: a.sources.INSTAGRAM },
          after: {
            source: 'Profesional externo',
            sourceId: a.sources.EXTERNAL_PROFESSIONAL,
          },
        },
      },
    });
    expect(JSON.stringify(events[0].metadata)).not.toContain('Carmen');
    // Sin cambios, sin evento.
    await context.run(a.tenantId, () =>
      patients.update(p, { sourceId: a.sources.EXTERNAL_PROFESSIONAL }, ctx(a)),
    );
    expect(
      await raw.auditEvent.count({
        where: { tenantId: a.tenantId, resourceId: p, action: 'UPDATE' },
      }),
    ).toBe(1);
  });

  it('la supresión parcial borra el vínculo «X recomendó a Y» en los dos sentidos y conserva la fuente', async () => {
    const x = await patient(a, 'Recomienda', {
      sourceId: a.sources.PATIENT_REFERRAL,
    });
    const y = await patient(a, 'Recomendado', {
      sourceId: a.sources.PATIENT_REFERRAL,
      referredByPatientId: x,
    });
    const z = await patient(a, 'Otro recomendado', {
      sourceId: a.sources.PATIENT_REFERRAL,
      referredByPatientId: y,
    });
    await context.run(a.tenantId, () =>
      patients.partiallySuppress(y, {
        reason: 'Solicitud del titular',
        actorId: a.adminId,
        assertAllowed: () => undefined,
      }),
    );
    const rows = await raw.patient.findMany({
      where: { id: { in: [x, y, z] } },
      select: { id: true, sourceId: true, referredByPatientId: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(y)).toEqual({
      id: y,
      sourceId: a.sources.PATIENT_REFERRAL,
      referredByPatientId: null,
    });
    expect(byId.get(z)).toEqual({
      id: z,
      sourceId: a.sources.PATIENT_REFERRAL,
      referredByPatientId: null,
    });
  });
});

describe('DX-172 · informe de captación en la BD', () => {
  let c: Clinic;
  let other: Clinic;

  beforeAll(async () => {
    c = await clinic('informe');
    other = await clinic('otra');
    // 3 de Instagram con 100.000 VES cobrados en la sede principal (más un
    // abono anulado que no cuenta y uno de septiembre fuera del período).
    const ig = [
      await patient(c, 'Instagram 1', {
        sourceId: c.sources.INSTAGRAM,
        createdAt: IN_OCTOBER,
      }),
      await patient(c, 'Instagram 2', {
        sourceId: c.sources.INSTAGRAM,
        createdAt: IN_OCTOBER,
      }),
      await patient(c, 'Instagram 3', {
        sourceId: c.sources.INSTAGRAM,
        createdAt: IN_OCTOBER,
      }),
    ];
    for (const id of ig) await firstVisit(c, id, c.main);
    await pay(c, ig[0], 50_000);
    await pay(c, ig[1], 30_000);
    await pay(c, ig[2], 20_000);
    await pay(c, ig[2], 9_999, { voided: true });
    await pay(c, ig[0], 7_777, { paidAt: '2026-11-01T16:00:00.000Z' });
    // 1 de Google sin abonos.
    const google = await patient(c, 'Google', {
      sourceId: c.sources.GOOGLE,
      createdAt: IN_OCTOBER,
    });
    await firstVisit(c, google, c.main);
    // 1 sin fuente y sin citas (sin sede de captación).
    await patient(c, 'Sin fuente', { createdAt: IN_OCTOBER });
    // En Norte: recomendado por Instagram 1, cobrado en USD.
    const norte = await patient(c, 'Norte', {
      sourceId: c.sources.PATIENT_REFERRAL,
      referredByPatientId: ig[0],
      createdAt: IN_OCTOBER,
    });
    await firstVisit(c, norte, c.norte);
    await pay(c, norte, 25.5, { currency: 'USD', locationId: c.norte });
    // De septiembre: no es nuevo de octubre.
    await patient(c, 'Septiembre', {
      sourceId: c.sources.INSTAGRAM,
      createdAt: new Date('2026-09-15T16:00:00.000Z'),
    });
    // Otra clínica con un paciente de Instagram: no se cuela.
    await patient(other, 'Ajeno', {
      sourceId: other.sources.INSTAGRAM,
      createdAt: IN_OCTOBER,
    });
  }, 60_000);

  const run = (
    tenantId: string,
    input: Partial<Parameters<GetAcquisitionUseCase['execute']>[0]> = {},
  ) =>
    context.run(tenantId, () =>
      report.execute({ ...OCTOBER, allowedLocationIds: 'ALL', ...input }),
    );

  it('3 de Instagram con 100.000 VES, 1 de Google sin abonos, «Sin dato» y los anulados no cuentan', async () => {
    const r = await run(c.tenantId);
    expect(row(r, 'Instagram')).toMatchObject({
      newPatients: 3,
      payingPatients: 3,
      collected: [{ currency: 'VES', amount: 100_000 }],
    });
    expect(row(r, 'Google')).toMatchObject({
      newPatients: 1,
      payingPatients: 0,
      collected: [],
    });
    expect(row(r, 'Sin dato')).toMatchObject({
      sourceId: null,
      newPatients: 1,
      collected: [],
    });
    expect(row(r, 'Recomendación de paciente')).toMatchObject({
      newPatients: 1,
      collected: [{ currency: 'USD', amount: 25.5 }],
    });
    expect(r.totals).toEqual({
      newPatients: 6,
      payingPatients: 4,
      collected: [
        { currency: 'USD', amount: 25.5 },
        { currency: 'VES', amount: 100_000 },
      ],
    });
    expect(r.topReferrers).toEqual([
      expect.objectContaining({
        fullName: 'Paciente Instagram 1',
        referred: 1,
        collected: [{ currency: 'USD', amount: 25.5 }],
      }),
    ]);
  });

  it('por sede: la de la primera cita; los sin citas solo en «Todas»', async () => {
    const main = await run(c.tenantId, { locationId: c.main });
    expect(main.filters).toEqual({
      locationId: c.main,
      locationName: 'Sede principal',
    });
    expect(row(main, 'Instagram').newPatients).toBe(3);
    expect(main.rows.find((x) => x.name === 'Sin dato')).toBeUndefined();
    expect(main.totals.collected).toEqual([
      { currency: 'VES', amount: 100_000 },
    ]);
    const norte = await run(c.tenantId, { locationId: c.norte });
    expect(norte.totals).toEqual({
      newPatients: 1,
      payingPatients: 1,
      collected: [{ currency: 'USD', amount: 25.5 }],
    });
    // Un miembro restringido a Norte: lo mismo, sin los sin sede.
    const restricted = await run(c.tenantId, { allowedLocationIds: [c.norte] });
    expect(restricted.totals.newPatients).toBe(1);
  });

  it('desactivar una fuente la conserva en el informe mientras haya traído pacientes', async () => {
    await raw.patientSource.update({
      where: { id: c.sources.GOOGLE },
      data: { isActive: false },
    });
    try {
      const r = await run(c.tenantId);
      expect(row(r, 'Google')).toMatchObject({
        isActive: false,
        newPatients: 1,
      });
      const november = await run(c.tenantId, {
        from: '2026-11-01',
        to: '2026-11-30',
      });
      expect(november.rows.find((x) => x.name === 'Google')).toBeUndefined();
    } finally {
      await raw.patientSource.update({
        where: { id: c.sources.GOOGLE },
        data: { isActive: true },
      });
    }
  });

  it('la otra clínica solo ve lo suyo', async () => {
    const r = await run(other.tenantId);
    expect(r.totals.newPatients).toBe(1);
    expect(row(r, 'Instagram').newPatients).toBe(1);
  });
});

/** Un nodo del plan ejecutado (EXPLAIN ANALYZE, FORMAT JSON). */
interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows'?: number;
  'Sort Space Type'?: string;
  Plans?: PlanNode[];
}

const nodesOf = (node: PlanNode): PlanNode[] => [
  node,
  ...(node.Plans ?? []).flatMap(nodesOf),
];

describe('DX-172 · plan del informe (invariantes, sin cronómetro)', () => {
  let c: Clinic;
  const HISTORY = 12_000;

  beforeAll(async () => {
    c = await clinic('plan');
    // 12 000 pacientes repartidos en 24 meses y 9 fuentes (y sin fuente),
    // con una cita y un abono cada uno: la historia que el informe de un mes
    // no debe recorrer.
    const sources = Object.values(c.sources);
    await raw.$executeRaw`
      INSERT INTO "patients" ("id", "tenantId", "firstName", "lastName", "sourceId", "createdAt", "updatedAt")
      SELECT gen_random_uuid(), ${c.tenantId}::uuid, 'Paciente', 'Plan ' || g,
             CASE WHEN g % 10 = 0 THEN NULL ELSE (${sources}::uuid[])[1 + g % ${sources.length}] END,
             timestamp '2025-01-01 16:00' + (g % 730) * interval '1 day',
             now()
        FROM generate_series(1, ${HISTORY}) AS g`;
    await raw.$executeRaw`
      INSERT INTO "appointments" ("id", "tenantId", "locationId", "patientId", "providerId", "start", "end", "updatedAt")
      SELECT gen_random_uuid(), x."tenantId", ${c.main}::uuid, x."id", ${c.providerId}::uuid,
             x."start", x."start" + interval '30 minutes', now()
        FROM (SELECT p.*, timestamp '2027-02-01 12:00'
                          + (row_number() OVER (ORDER BY p."id")) * interval '40 minutes' AS "start"
                FROM "patients" p WHERE p."tenantId" = ${c.tenantId}::uuid) x`;
    await raw.$executeRaw`
      INSERT INTO "treatment_plans" ("id", "tenantId", "patientId", "currency", "updatedAt")
      SELECT gen_random_uuid(), p."tenantId", p."id", 'VES', now()
        FROM "patients" p WHERE p."tenantId" = ${c.tenantId}::uuid`;
    await raw.$executeRaw`
      INSERT INTO "payments" ("id", "tenantId", "locationId", "treatmentPlanId", "patientId", "amount", "currency", "paidAt", "method", "updatedAt")
      SELECT gen_random_uuid(), p."tenantId", ${c.main}::uuid, tp."id", p."id", 100, 'VES',
             p."createdAt" + interval '2 days', 'CASH', now()
        FROM "patients" p
        JOIN "treatment_plans" tp ON tp."tenantId" = p."tenantId" AND tp."patientId" = p."id"
       WHERE p."tenantId" = ${c.tenantId}::uuid`;
    await raw.$executeRaw`ANALYZE "patients"`;
    await raw.$executeRaw`ANALYZE "appointments"`;
    await raw.$executeRaw`ANALYZE "payments"`;
  }, 180_000);

  /** Las consultas que manda el repositorio, capturadas sin cambiarlas. */
  async function capture(run: () => Promise<unknown>) {
    const queries: Prisma.Sql[] = [];
    const original = prisma.runWithTenant.bind(prisma) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const spy = jest
      .spyOn(prisma, 'runWithTenant')
      .mockImplementation((...args: unknown[]) => {
        const at = typeof args[0] === 'function' ? 0 : 1;
        const fn = args[at] as (tx: Prisma.TransactionClient) => unknown;
        args[at] = (tx: Prisma.TransactionClient) =>
          fn(
            new Proxy(tx, {
              get(target, prop, receiver) {
                if (prop !== '$queryRaw') {
                  return Reflect.get(target, prop, receiver) as unknown;
                }
                return (query: TemplateStringsArray, ...values: unknown[]) => {
                  const sql = Prisma.sql(query, ...values);
                  queries.push(sql);
                  return target.$queryRaw(sql);
                };
              },
            }),
          );
        return original(...args);
      });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return queries;
  }

  async function executedPlan(sql: Prisma.Sql): Promise<PlanNode> {
    return prisma.runWithTenant(c.tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<
        { 'QUERY PLAN': { Plan: PlanNode }[] }[]
      >(Prisma.sql`EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) ${sql}`);
      return row['QUERY PLAN'][0].Plan;
    });
  }

  it('un mes: UNA consulta agregada, por el índice (tenantId, sourceId, createdAt), sin recorrer la historia ni ordenar a disco', async () => {
    const execute = () =>
      context.run(c.tenantId, () =>
        report.execute({ ...OCTOBER, allowedLocationIds: 'ALL' }),
      );
    const result = await execute();
    // ~1/24 de la historia es de octubre de 2026 (fuera: la siembra acaba
    // en dic-2026; octubre está dentro).
    expect(result.totals.newPatients).toBeGreaterThan(0);
    expect(result.totals.newPatients).toBeLessThan(HISTORY / 10);
    const queries = await capture(execute);
    const aggregates = queries.filter((q) => q.sql.includes('WITH cand AS'));
    // Sin N+1: una sola consulta agregada (lo demás son el catálogo, la
    // siembra idempotente y las zonas: un número fijo).
    expect(aggregates).toHaveLength(1);
    expect(queries.length).toBeLessThanOrEqual(3);
    const nodes = nodesOf(await executedPlan(aggregates[0]));
    const stats = {
      seqScans: nodes
        .filter((n) => n['Node Type'] === 'Seq Scan')
        .map((n) => n['Relation Name']),
      indexes: [...new Set(nodes.map((n) => n['Index Name']).filter(Boolean))],
      maxRows: Math.max(...nodes.map((n) => n['Actual Rows'] ?? 0)),
      diskSorts: nodes.filter((n) => n['Sort Space Type'] === 'Disk').length,
    };
    console.info(
      `DX-172 · captación, ${HISTORY} pacientes, 1 mes: ${JSON.stringify(stats)}`,
    );
    expect(stats.seqScans).not.toContain('patients');
    expect(stats.seqScans).not.toContain('payments');
    expect(stats.seqScans).not.toContain('appointments');
    expect(stats.indexes).toContain('patients_tenant_source_created_idx');
    expect(stats.diskSorts).toBe(0);
    // Ningún nodo crece con la historia: como mucho, los pacientes del mes
    // (y sus citas y abonos) con margen.
    expect(stats.maxRows).toBeLessThanOrEqual(
      2 * result.totals.newPatients + 20,
    );
  }, 120_000);
});
