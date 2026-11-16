import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPerioExamRepository } from '../src/modules/periodontal/infrastructure/repositories/prisma-perio-exam.repository';
import {
  PERIO_SITES,
  computePerioIndices,
  encodeFlags,
  indicesFromCounts,
} from '../src/modules/periodontal/domain/perio-measures';
import type {
  PerioSiteMeasure,
  PerioToothMeasure,
} from '../src/modules/periodontal/domain/entities/perio-exam.entity';
import type { SavePerioMeasuresRepoInput } from '../src/modules/periodontal/domain/ports/perio-exam-repository.port';

// DX-103: el guardado del periodontograma va en un lote (≤6 sentencias SQL,
// BEGIN y COMMIT incluidos) en vez de un upsert por celda (≈224 idas y vueltas),
// y el listado trae el resumen calculado en la base, sin las medidas.
//
// Todo escribe por la ruta de la app (runWithTenant, rol dentalix_app, RLS);
// `raw` (DIRECT_URL, owner) solo siembra, lee para comparar y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaPerioExamRepository(prisma, tenantContext);

/**
 * Un PrismaService que anota cada sentencia que manda a Postgres (log de
 * Prisma por eventos; BEGIN y COMMIT también cuentan). Usa el MISMO
 * `runWithTenant` que la app: solo cambia el cliente que hay debajo.
 */
function observedPrisma(): { service: PrismaService; queries: string[] } {
  const queries: string[] = [];
  // `$on('query')` solo existe si el tipo conoce el `log` por eventos.
  // eslint-disable-next-line no-restricted-syntax
  const client = new PrismaClient({
    log: [{ emit: 'event', level: 'query' }],
  });
  client.$on('query', (event) => queries.push(event.query));
  // El `runWithTenant` de la app, con este cliente como `this` (lo usa para
  // `$transaction` y `tenantContext`): se toma del prototipo a propósito.
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
      fullName: 'Dra. Lote',
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

/** Generador determinista (LCG) para que el lote varíe entre corridas fijas. */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/**
 * Periodontograma completo: 192 sitios y 32 dientes, con nulos, recesión
 * negativa, todas las combinaciones de marcas y celdas vacías (que limpian).
 */
function fullChart(seed: number): SavePerioMeasuresRepoInput {
  const next = rng(seed);
  const pick = (n: number) => Math.floor(next() * n);
  const sites: PerioSiteMeasure[] = TEETH.flatMap((toothFdi) =>
    PERIO_SITES.map((site) => {
      const empty = pick(10) === 0;
      return {
        toothFdi,
        site,
        probingMm: empty || pick(8) === 0 ? null : pick(12),
        recessionMm: empty || pick(3) === 0 ? null : pick(10) - 3,
        furcation: empty || pick(4) !== 0 ? null : pick(4),
        bleeding: !empty && pick(3) === 0,
        suppuration: !empty && pick(9) === 0,
        plaque: !empty && pick(2) === 0,
        calculus: !empty && pick(5) === 0,
      };
    }),
  );
  const teeth: PerioToothMeasure[] = TEETH.map((toothFdi) => ({
    toothFdi,
    mobility: pick(3) === 0 ? pick(4) : null,
    skipped: pick(8) === 0,
  }));
  return { sites, teeth, notes: `lote ${seed}` };
}

/** El guardado de antes de DX-103 (DX-007): un upsert por celda. */
async function saveRowByRow(
  tenantId: string,
  examId: string,
  input: SavePerioMeasuresRepoInput,
): Promise<void> {
  await prisma.runWithTenant(
    tenantId,
    async (tx) => {
      await tx.perioExam.updateMany({
        where: { id: examId, status: 'DRAFT', deletedAt: null },
        data: {
          updatedAt: new Date(),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
      });
      for (const s of input.sites) {
        const values = {
          probingMm: s.probingMm,
          recessionMm: s.recessionMm,
          furcation: s.furcation,
          flags: encodeFlags(s),
        };
        await tx.perioSiteMeasure.upsert({
          where: {
            tenantId_examId_toothFdi_site: {
              tenantId,
              examId,
              toothFdi: s.toothFdi,
              site: s.site,
            },
          },
          create: {
            tenantId,
            examId,
            toothFdi: s.toothFdi,
            site: s.site,
            ...values,
          },
          update: values,
        });
      }
      for (const t of input.teeth) {
        const values = { mobility: t.mobility, skipped: t.skipped };
        await tx.perioToothMeasure.upsert({
          where: {
            tenantId_examId_toothFdi: {
              tenantId,
              examId,
              toothFdi: t.toothFdi,
            },
          },
          create: { tenantId, examId, toothFdi: t.toothFdi, ...values },
          update: values,
        });
      }
    },
    { timeout: 30_000 },
  );
}

/** Foto comparable de un examen: medidas sin ids, ordenadas. */
async function snapshot(examId: string) {
  const [exam, sites, teeth] = await Promise.all([
    raw.perioExam.findUniqueOrThrow({
      where: { id: examId },
      select: { notes: true, status: true },
    }),
    raw.perioSiteMeasure.findMany({
      where: { examId },
      select: {
        tenantId: true,
        toothFdi: true,
        site: true,
        probingMm: true,
        recessionMm: true,
        furcation: true,
        flags: true,
      },
      orderBy: [{ toothFdi: 'asc' }, { site: 'asc' }],
    }),
    raw.perioToothMeasure.findMany({
      where: { examId },
      select: { tenantId: true, toothFdi: true, mobility: true, skipped: true },
      orderBy: { toothFdi: 'asc' },
    }),
  ]);
  return { exam, sites, teeth };
}

function sitesOf(snap: Awaited<ReturnType<typeof snapshot>>): string {
  return snap.sites.map((s) => s.probingMm).join(',');
}

describe('periodontograma: guardado en lote y lista sin medidas (DX-103, int)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    a = await seedClinic('perio-lote-a');
    b = await seedClinic('perio-lote-b');
  });

  afterAll(async () => {
    const tenantIds = [a.tenantId, b.tenantId];
    // Sin `app.current_tenant` (owner): los triggers dejan borrar.
    await raw.perioExam.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await raw.patient.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await raw.user.deleteMany({
      where: { id: { in: [a.userId, b.userId] } },
    });
    await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  function asA<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(a.tenantId, undefined, fn);
  }

  it('un periodontograma completo (192 sitios y 32 dientes) se guarda con ≤6 sentencias', async () => {
    const { service, queries } = observedPrisma();
    const observed = new PrismaPerioExamRepository(service, tenantContext);
    try {
      // Tres corridas seguidas sobre la misma base: la primera inserta, las
      // otras actualizan (y la tercera repite la segunda: nada cambia).
      for (const seed of [1, 2, 2]) {
        const examId = seed === 1 ? await newExam(a) : undefined;
        const target = examId ?? (await lastDraft(a));
        queries.length = 0;
        const result = await asA(() =>
          observed.saveMeasures(a.patientId, target, fullChart(seed)),
        );
        expect(result).toBe('ok');
        await settle();
        expect(queries.at(-1)).toBe('COMMIT');
        // Se imprime para el informe (antes ≈ 227).
        console.log(
          `DX-103 saveMeasures (semilla ${seed}): ${queries.length} sentencias\n  ${queries.map((q) => q.replace(/\s+/g, ' ').slice(0, 90)).join('\n  ')}`,
        );
        expect(queries.length).toBeLessThanOrEqual(6);
      }
    } finally {
      await service.$disconnect();
    }
  });

  async function lastDraft(clinic: Clinic): Promise<string> {
    const exam = await raw.perioExam.findFirstOrThrow({
      where: { tenantId: clinic.tenantId, status: 'DRAFT', deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return exam.id;
  }

  it('deja exactamente lo mismo que el guardado fila a fila (alta, cambios y celdas limpiadas)', async () => {
    const batchId = await newExam(a);
    const rowId = await newExam(a);
    // 1) Alta de todo; 2) cambios sobre todo; 3) solo unas celdas, incluidas
    // vacías (limpian) y un diente que deja de estar omitido.
    const partial = fullChart(9);
    const third: SavePerioMeasuresRepoInput = {
      sites: partial.sites.slice(0, 40).map((s, i) =>
        i % 3 === 0
          ? {
              ...s,
              probingMm: null,
              recessionMm: null,
              furcation: null,
              bleeding: false,
              suppuration: false,
              plaque: false,
              calculus: false,
            }
          : s,
      ),
      teeth: [{ toothFdi: 16, mobility: null, skipped: false }],
    };
    for (const input of [fullChart(3), fullChart(4), third]) {
      expect(
        await asA(() => repo.saveMeasures(a.patientId, batchId, input)),
      ).toBe('ok');
      await saveRowByRow(a.tenantId, rowId, input);
      const [batch, rowByRow] = await Promise.all([
        snapshot(batchId),
        snapshot(rowId),
      ]);
      expect(batch).toEqual(rowByRow);
    }
    // La comparación tiene contenido: 192 sitios y 32 dientes, cada uno una vez.
    const final = await snapshot(batchId);
    expect(final.sites).toHaveLength(192);
    expect(final.teeth).toHaveLength(32);
    expect(final.exam.notes).toBe('lote 4');
  });

  it('un lote vacío solo toca la cabecera (notas) y no manda INSERT', async () => {
    const examId = await newExam(a);
    const { service, queries } = observedPrisma();
    const observed = new PrismaPerioExamRepository(service, tenantContext);
    try {
      await asA(() =>
        observed.saveMeasures(a.patientId, examId, {
          sites: [],
          teeth: [],
          notes: 'solo notas',
        }),
      );
      await settle();
      expect(queries.some((q) => q.trim().startsWith('INSERT'))).toBe(false);
      expect(queries.length).toBe(4);
    } finally {
      await service.$disconnect();
    }
    expect((await snapshot(examId)).exam.notes).toBe('solo notas');
  });

  it('dos guardados a la vez del mismo borrador se serializan: gana uno entero, sin mezclas', async () => {
    for (let round = 0; round < 3; round += 1) {
      const examId = await newExam(a);
      const all = (probingMm: number): SavePerioMeasuresRepoInput => ({
        sites: TEETH.flatMap((toothFdi) =>
          PERIO_SITES.map((site) => ({
            toothFdi,
            site,
            probingMm,
            recessionMm: null,
            furcation: null,
            bleeding: false,
            suppuration: false,
            plaque: false,
            calculus: false,
          })),
        ),
        teeth: [],
      });
      const results = await Promise.all([
        asA(() => repo.saveMeasures(a.patientId, examId, all(3))),
        asA(() => repo.saveMeasures(a.patientId, examId, all(5))),
      ]);
      expect(results).toEqual(['ok', 'ok']);
      const snap = await snapshot(examId);
      expect(snap.sites).toHaveLength(192);
      expect([
        Array(192).fill(3).join(','),
        Array(192).fill(5).join(','),
      ]).toContain(sitesOf(snap));
    }
  });

  it('guardar y finalizar a la vez: o se guarda y luego se finaliza, o el guardado da «final» y no escribe', async () => {
    for (let round = 0; round < 3; round += 1) {
      const examId = await newExam(a);
      const [saved, finalized] = await Promise.all([
        asA(() => repo.saveMeasures(a.patientId, examId, fullChart(5))),
        asA(() => repo.finalize(a.patientId, examId, new Date())),
      ]);
      expect(finalized).toBe('ok');
      const snap = await snapshot(examId);
      expect(snap.exam.status).toBe('FINAL');
      if (saved === 'ok') {
        expect(snap.sites).toHaveLength(192);
      } else {
        expect(saved).toBe('final');
        expect(snap.sites).toHaveLength(0);
      }
    }
  });

  it('un examen FINAL es inmutable: el repositorio da «final» y el trigger frena un lote directo', async () => {
    const finalId = await newExam(a, {
      status: 'FINAL',
      finalizedAt: new Date(),
    });
    expect(
      await asA(() => repo.saveMeasures(a.patientId, finalId, fullChart(6))),
    ).toBe('final');
    expect((await snapshot(finalId)).sites).toHaveLength(0);
    // Aunque una ruta futura se saltara el UPDATE de guarda, el trigger de
    // inmutabilidad (DX-007) sigue frenando una escritura por conjuntos.
    await expect(
      prisma.runWithTenant(
        a.tenantId,
        (tx) => tx.$executeRaw`
          INSERT INTO "perio_site_measures" ("id", "tenantId", "examId", "toothFdi", "site", "probingMm")
          SELECT gen_random_uuid(), ${a.tenantId}::uuid, ${finalId}::uuid, u.t, u.s::"PerioSite", 3
          FROM unnest(${[11, 12]}::smallint[], ${['MB', 'B']}::text[]) AS u(t, s)`,
      ),
    ).rejects.toThrow(/finalizado/);
  });

  it('RLS: no se guarda en el examen de otra clínica ni de otro paciente', async () => {
    const examOfB = await newExam(b);
    expect(
      await asA(() => repo.saveMeasures(b.patientId, examOfB, fullChart(7))),
    ).toBe('not_found');
    expect(
      await asA(() => repo.saveMeasures(a.patientId, examOfB, fullChart(7))),
    ).toBe('not_found');
    expect((await snapshot(examOfB)).sites).toHaveLength(0);
  });

  it('la lista trae el resumen calculado en la base, igual que con las medidas, y con tope', async () => {
    const clinic = await seedClinic('perio-lote-lista');
    const ids: string[] = [];
    try {
      for (let i = 0; i < 4; i += 1) {
        const id = await newExam(clinic, {
          examDate: new Date(`2026-0${i + 1}-15T00:00:00.000Z`),
        });
        ids.push(id);
        const input = fullChart(20 + i);
        await tenantContext.run(clinic.tenantId, undefined, () =>
          repo.saveMeasures(clinic.patientId, id, input),
        );
      }
      // Un borrador retirado no sale.
      await raw.perioExam.update({
        where: { id: ids[0] },
        data: { deletedAt: new Date() },
      });
      const { service, queries } = observedPrisma();
      const observed = new PrismaPerioExamRepository(service, tenantContext);
      let list: Awaited<ReturnType<typeof repo.listSummaries>>;
      try {
        list = await tenantContext.run(clinic.tenantId, undefined, () =>
          observed.listSummaries(clinic.patientId, 10),
        );
        await settle();
        console.log(
          `DX-103 listSummaries: ${queries.length} sentencias\n  ${queries.map((q) => q.replace(/\s+/g, ' ').slice(0, 90)).join('\n  ')}`,
        );
        // BEGIN, set_config, la consulta del resumen y COMMIT: ninguna lee
        // las medidas fila a fila.
        expect(queries.length).toBeLessThanOrEqual(4);
      } finally {
        await service.$disconnect();
      }
      expect(list.map((e) => e.id)).toEqual([ids[3], ids[2], ids[1]]);
      for (const summary of list) {
        const detail = await tenantContext.run(clinic.tenantId, undefined, () =>
          repo.findById(clinic.patientId, summary.id),
        );
        expect(indicesFromCounts(summary.counts)).toEqual(
          computePerioIndices(detail!.sites, detail!.teeth),
        );
        expect(summary.providerName).toBe('Dra. Lote');
        expect(summary).not.toHaveProperty('sites');
        expect(summary).not.toHaveProperty('teeth');
      }
      const capped = await tenantContext.run(clinic.tenantId, undefined, () =>
        repo.listSummaries(clinic.patientId, 2),
      );
      expect(capped.map((e) => e.id)).toEqual([ids[3], ids[2]]);
      // Otra clínica no ve nada del paciente.
      await expect(
        asA(() => repo.listSummaries(clinic.patientId, 10)),
      ).resolves.toEqual([]);
    } finally {
      await raw.perioExam.deleteMany({ where: { tenantId: clinic.tenantId } });
      await raw.patient.deleteMany({ where: { tenantId: clinic.tenantId } });
      await raw.user.deleteMany({ where: { id: clinic.userId } });
      await raw.tenant.deleteMany({ where: { id: clinic.tenantId } });
    }
  });

  it('un examen sin medidas da índices a cero en la lista', async () => {
    const clinic = await seedClinic('perio-lote-vacio');
    try {
      await newExam(clinic);
      const [summary] = await tenantContext.run(
        clinic.tenantId,
        undefined,
        () => repo.listSummaries(clinic.patientId, 10),
      );
      expect(indicesFromCounts(summary.counts)).toEqual(
        computePerioIndices([], []),
      );
    } finally {
      await raw.perioExam.deleteMany({ where: { tenantId: clinic.tenantId } });
      await raw.patient.deleteMany({ where: { tenantId: clinic.tenantId } });
      await raw.user.deleteMany({ where: { id: clinic.userId } });
      await raw.tenant.deleteMany({ where: { id: clinic.tenantId } });
    }
  });
});
