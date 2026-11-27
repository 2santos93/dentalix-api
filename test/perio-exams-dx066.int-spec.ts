import { Prisma, PrismaClient } from '@prisma/client';
import { performance } from 'node:perf_hooks';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPerioExamRepository } from '../src/modules/periodontal/infrastructure/repositories/prisma-perio-exam.repository';
import {
  PERIO_SITES,
  computePerioIndices,
  indicesFromCounts,
} from '../src/modules/periodontal/domain/perio-measures';
import type { SavePerioMeasuresRepoInput } from '../src/modules/periodontal/domain/ports/perio-exam-repository.port';

// DX-066 (integración con Postgres): el guardado de 32 dientes completos es
// UNA sentencia por tabla, el FINAL sigue inmutable también para las notas y
// los umbrales por clínica se guardan con su CHECK y cuentan en la base igual
// que en memoria.
//
// La app escribe por runWithTenant (rol dentalix_app, RLS); `raw` (DIRECT_URL,
// owner) solo siembra, lee para comparar y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaPerioExamRepository(prisma, tenantContext);

/** Un PrismaService que anota cada sentencia (mismo `runWithTenant` que la app). */
function observedPrisma(): { service: PrismaService; queries: string[] } {
  const queries: string[] = [];
  // eslint-disable-next-line no-restricted-syntax
  const client = new PrismaClient({
    log: [{ emit: 'event', level: 'query' }],
  });
  client.$on('query', (event) => queries.push(event.query));
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const runWithTenant = PrismaService.prototype.runWithTenant;
  const service = Object.assign(client, {
    tenantContext,
    runWithTenant,
  }) as unknown as PrismaService;
  return { service, queries };
}

/** El evento del COMMIT puede llegar justo después de resolver la promesa. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

interface Clinic {
  tenantId: string;
  patientId: string;
  userId: string;
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const patient = await raw.patient.create({
    data: { tenantId: tenant.id, firstName: 'Ana', lastName: subdomain },
  });
  const user = await raw.user.create({
    data: {
      email: `perio@${subdomain}.test`,
      passwordHash: 'x',
      fullName: 'Dra. Umbral',
    },
  });
  return { tenantId: tenant.id, patientId: patient.id, userId: user.id };
}

async function newExam(
  clinic: Clinic,
  data: Partial<Prisma.PerioExamUncheckedCreateInput> = {},
): Promise<string> {
  const exam = await raw.perioExam.create({
    data: {
      tenantId: clinic.tenantId,
      patientId: clinic.patientId,
      providerId: clinic.userId,
      examDate: new Date('2026-10-01T00:00:00.000Z'),
      ...data,
    },
  });
  return exam.id;
}

const TEETH = [11, 12, 13, 14, 15, 16, 17, 18]
  .flatMap((t) => [t, t + 10, t + 20, t + 30])
  .sort((a, b) => a - b);

/** 32 dientes completos: 192 sitios con todo y 32 dientes. */
function fullChart(offset: number): SavePerioMeasuresRepoInput {
  return {
    sites: TEETH.flatMap((toothFdi, t) =>
      PERIO_SITES.map((site, i) => ({
        toothFdi,
        site,
        probingMm: (t + i + offset) % 10,
        recessionMm: ((t * i + offset) % 7) - 2,
        furcation: toothFdi % 10 >= 6 && site === 'B' ? (t + offset) % 4 : null,
        bleeding: (t + i + offset) % 3 === 0,
        suppuration: (t + i) % 9 === 0,
        plaque: (t + i + offset) % 4 === 0,
        calculus: (t + i) % 5 === 0,
      })),
    ),
    teeth: TEETH.map((toothFdi, t) => ({
      toothFdi,
      mobility: t % 4 === 0 ? (t + offset) % 4 : null,
      skipped: false,
    })),
  };
}

describe('periodontograma DX-066 (int)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    a = await seedClinic('perio-dx066-a');
    b = await seedClinic('perio-dx066-b');
  });

  afterAll(async () => {
    const tenantIds = [a.tenantId, b.tenantId];
    await raw.perioExam.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await raw.patient.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await raw.user.deleteMany({ where: { id: { in: [a.userId, b.userId] } } });
    await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  function asA<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(a.tenantId, undefined, fn);
  }

  it('32 dientes completos: UNA sentencia por tabla (INSERT … ON CONFLICT) y < 1 s en local', async () => {
    const { service, queries } = observedPrisma();
    const observed = new PrismaPerioExamRepository(service, tenantContext);
    try {
      const examId = await newExam(a);
      // Alta y después cambio de todo: las dos corridas, mismo plan.
      for (const offset of [0, 1]) {
        queries.length = 0;
        const started = performance.now();
        const result = await asA(() =>
          observed.saveMeasures(a.patientId, examId, fullChart(offset)),
        );
        const elapsedMs = performance.now() - started;
        expect(result).toBe('ok');
        await settle();
        const inserts = (table: string) =>
          queries.filter((q) =>
            new RegExp(`^\\s*INSERT INTO "public"\\."${table}"`).test(q),
          );
        // Ninguna sentencia por celda: una por tabla, y nada fila a fila.
        expect(inserts('perio_site_measures')).toHaveLength(1);
        expect(inserts('perio_tooth_measures')).toHaveLength(1);
        expect(inserts('perio_site_measures')[0]).toMatch(/ON CONFLICT/);
        expect(inserts('perio_tooth_measures')[0]).toMatch(/ON CONFLICT/);
        expect(
          queries.filter((q) => /^\s*(INSERT|UPDATE)/.test(q)),
        ).toHaveLength(3);
        expect(queries.at(-1)).toBe('COMMIT');
        console.log(
          `DX-066 saveMeasures 32 dientes (offset ${offset}): ${queries.length} sentencias, ${Math.trunc(elapsedMs)} ms`,
        );
        // El tiempo solo se exige en local: en la CI manda el recuento.
        if (!process.env.CI) {
          expect(elapsedMs).toBeLessThan(1000);
        }
      }
      const stored = await raw.perioSiteMeasure.count({ where: { examId } });
      expect(stored).toBe(192);
      expect(await raw.perioToothMeasure.count({ where: { examId } })).toBe(32);
    } finally {
      await service.$disconnect();
    }
  });

  it('notas: el DRAFT cambia; el FINAL da «final» y el trigger frena un UPDATE directo', async () => {
    const draftId = await newExam(a, { notes: 'Inicial' });
    expect(
      await asA(() => repo.updateNotes(a.patientId, draftId, 'Revisado')),
    ).toBe('ok');
    expect(
      (await raw.perioExam.findUniqueOrThrow({ where: { id: draftId } })).notes,
    ).toBe('Revisado');

    const finalId = await newExam(a, {
      notes: 'Cerrado',
      status: 'FINAL',
      finalizedAt: new Date(),
    });
    expect(
      await asA(() => repo.updateNotes(a.patientId, finalId, 'Cambio')),
    ).toBe('final');
    await expect(
      prisma.runWithTenant(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "perio_exams" SET "notes" = 'Colado' WHERE "id" = ${finalId}::uuid`,
      ),
    ).rejects.toThrow(/finalizado/);
    expect(
      (await raw.perioExam.findUniqueOrThrow({ where: { id: finalId } })).notes,
    ).toBe('Cerrado');
    // Otra clínica u otro paciente: «not_found».
    expect(
      await tenantContext.run(b.tenantId, undefined, () =>
        repo.updateNotes(a.patientId, draftId, 'Intruso'),
      ),
    ).toBe('not_found');
    expect(
      await asA(() => repo.updateNotes(b.patientId, draftId, 'Intruso')),
    ).toBe('not_found');
  });

  it('umbrales: 4/6 de fábrica, se guardan por clínica y el CHECK frena alerta ≥ severo o fuera de rango', async () => {
    await expect(asA(() => repo.thresholds())).resolves.toEqual({
      pdAlertMm: 4,
      pdSevereMm: 6,
    });
    const { before, after } = await asA(() =>
      repo.setThresholds({ pdAlertMm: 5, pdSevereMm: 8 }),
    );
    expect(before).toEqual({ pdAlertMm: 4, pdSevereMm: 6 });
    expect(after).toEqual({ pdAlertMm: 5, pdSevereMm: 8 });
    await expect(
      tenantContext.run(b.tenantId, undefined, () => repo.thresholds()),
    ).resolves.toEqual({ pdAlertMm: 4, pdSevereMm: 6 });

    for (const data of [
      { perioPdAlertMm: 6, perioPdSevereMm: 6 },
      { perioPdAlertMm: 1, perioPdSevereMm: 6 },
      { perioPdAlertMm: 4, perioPdSevereMm: 13 },
    ]) {
      await expect(
        raw.tenant.update({ where: { id: a.tenantId }, data }),
      ).rejects.toThrow(/tenants_perio_pd_thresholds_check/);
    }
    await asA(() => repo.setThresholds({ pdAlertMm: 4, pdSevereMm: 6 }));
  });

  it('la lista cuenta en la base con los umbrales igual que el detalle en memoria', async () => {
    const clinic = await seedClinic('perio-dx066-lista');
    try {
      const id = await newExam(clinic);
      await tenantContext.run(clinic.tenantId, undefined, () =>
        repo.saveMeasures(clinic.patientId, id, fullChart(3)),
      );
      for (const thresholds of [
        { pdAlertMm: 4, pdSevereMm: 6 },
        { pdAlertMm: 3, pdSevereMm: 5 },
        { pdAlertMm: 7, pdSevereMm: 9 },
      ]) {
        const [row] = await tenantContext.run(clinic.tenantId, undefined, () =>
          repo.listSummaries(clinic.patientId, 10, thresholds),
        );
        const detail = await tenantContext.run(clinic.tenantId, undefined, () =>
          repo.findById(clinic.patientId, id),
        );
        const expected = computePerioIndices(
          detail!.sites,
          detail!.teeth,
          thresholds,
        );
        expect(indicesFromCounts(row.counts)).toEqual(expected);
        expect(expected.sitesAlertOrMore).toBeGreaterThan(0);
      }
    } finally {
      await raw.perioExam.deleteMany({ where: { tenantId: clinic.tenantId } });
      await raw.patient.deleteMany({ where: { tenantId: clinic.tenantId } });
      await raw.user.deleteMany({ where: { id: clinic.userId } });
      await raw.tenant.deleteMany({ where: { id: clinic.tenantId } });
    }
  });

  it('comparación: una consulta trae los exámenes del paciente; ni de otro paciente ni de otra clínica', async () => {
    const ids = [
      await newExam(a, { status: 'FINAL', finalizedAt: new Date() }),
      await newExam(a, { status: 'FINAL', finalizedAt: new Date() }),
    ];
    const deleted = await newExam(a, { deletedAt: new Date() });
    const ofB = await newExam(b);
    const found = await asA(() =>
      repo.findManyByIds(a.patientId, [...ids, deleted, ofB]),
    );
    expect(found.map((e) => e.id).sort()).toEqual([...ids].sort());
    // Desde B (RLS) no se ve ninguno de A.
    expect(
      await tenantContext.run(b.tenantId, undefined, () =>
        repo.findManyByIds(a.patientId, ids),
      ),
    ).toEqual([]);
    // Desde otro paciente de la MISMA clínica, tampoco.
    expect(await asA(() => repo.findManyByIds(b.patientId, ids))).toEqual([]);
  });
});
