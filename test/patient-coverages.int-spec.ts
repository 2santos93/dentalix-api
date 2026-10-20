import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPatientCoverageRepository } from '../src/modules/patient-coverages/infrastructure/repositories/prisma-patient-coverage.repository';

// DX-153, capa DB: pagadores (payers) y coberturas del paciente
// (patient_coverages). RLS FORCE, FK COMPUESTAS (cruzar clínicas falla), las
// CHECK (tipo↔país, vigencia), los índices únicos parciales y el relleno de
// patients."insurerEps" (idempotente, sin tocar el texto). Lo que se prueba va
// por la MISMA ruta que la app (runWithTenant, rol dentalix_app, sujeto a
// RLS); `raw` (DIRECT_URL, superusuario) siembra y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAINS = ['dx153-int-a', 'dx153-int-b'];
const BACKFILL = readFileSync(
  join(
    __dirname,
    '../prisma/migrations/20261020210200_dx153_insurer_eps_backfill/migration.sql',
  ),
  'utf8',
);

interface Clinic {
  tenantId: string;
  patients: string[];
  payerId: string;
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const patients: string[] = [];
  for (const firstName of ['Uno', 'Dos']) {
    const patient = await raw.patient.create({
      data: { tenantId: tenant.id, firstName, lastName: subdomain },
    });
    patients.push(patient.id);
  }
  const payer = await raw.payer.create({
    data: {
      tenantId: tenant.id,
      name: 'Sanitas',
      type: 'EPS_CO',
      country: 'CO',
    },
  });
  return { tenantId: tenant.id, patients, payerId: payer.id };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length === 0) return;
  const where = { tenantId: { in: ids } };
  await raw.patientCoverage.deleteMany({ where });
  await raw.payer.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: { in: ids } } });
}

/** Ejecuta el SQL de la migración (varias sentencias) en UNA transacción, como Prisma. */
async function runBackfill(): Promise<void> {
  const statements = BACKFILL.split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  await raw.$transaction(statements.map((s) => raw.$executeRawUnsafe(s)));
}

describe('pagadores y coberturas (int, DX-153)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  // El bloque del relleno comparte el estado entre sus pruebas.
  let keepCoverages = false;
  afterEach(async () => {
    if (keepCoverages) return;
    await raw.patientCoverage.deleteMany({
      where: { tenantId: { in: [a.tenantId, b.tenantId] } },
    });
  });

  function asA<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(a.tenantId, fn);
  }

  const coverage = (
    clinic: Clinic,
    patientId: string,
    extra: Partial<Prisma.PatientCoverageUncheckedCreateInput> = {},
  ): Prisma.PatientCoverageUncheckedCreateInput => ({
    tenantId: clinic.tenantId,
    patientId,
    payerId: clinic.payerId,
    ...extra,
  });

  it('RLS FORCE: ambas tablas la tienen forzada y otra clínica no ve las filas', async () => {
    const rows = await raw.$queryRaw<
      { relname: string; rls: boolean; force: boolean }[]
    >`SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS force
        FROM pg_class WHERE relname IN ('payers', 'patient_coverages')
       ORDER BY relname`;
    expect(rows).toEqual([
      { relname: 'patient_coverages', rls: true, force: true },
      { relname: 'payers', rls: true, force: true },
    ]);

    await asA((tx) =>
      tx.patientCoverage.create({ data: coverage(a, a.patients[0]) }),
    );
    const fromB = await prisma.runWithTenant(b.tenantId, async (tx) => ({
      payers: await tx.payer.findMany({ where: { id: a.payerId } }),
      coverages: await tx.patientCoverage.count(),
    }));
    expect(fromB.payers).toHaveLength(0);
    expect(fromB.coverages).toBe(0);
    expect(await asA((tx) => tx.patientCoverage.count())).toBe(1);
    expect(await asA((tx) => tx.payer.count())).toBe(1);
  });

  it('FK compuesta: una cobertura de A con el pagador de B falla (23503)', async () => {
    await expect(
      raw.$executeRaw`INSERT INTO patient_coverages
        ("id", "tenantId", "patientId", "payerId", "updatedAt")
        VALUES (gen_random_uuid(), ${a.tenantId}::uuid, ${a.patients[0]}::uuid,
                ${b.payerId}::uuid, now())`,
    ).rejects.toThrow(/23503|foreign key/i);
  });

  it('CHECK tipo↔país: MUTUA_ES con CO se rechaza; MUTUA_ES con ES y OTRO sin país valen', async () => {
    await expect(
      raw.payer.create({
        data: {
          tenantId: a.tenantId,
          name: 'Mutua mala',
          type: 'MUTUA_ES',
          country: 'CO',
        },
      }),
    ).rejects.toThrow(/payers_type_country_check/);
    const ok = await raw.payer.createMany({
      data: [
        {
          tenantId: a.tenantId,
          name: 'Mutua buena',
          type: 'MUTUA_ES',
          country: 'ES',
        },
        { tenantId: a.tenantId, name: 'Otro sin país', type: 'OTRO' },
      ],
    });
    expect(ok.count).toBe(2);
    await raw.payer.deleteMany({
      where: {
        tenantId: a.tenantId,
        name: { in: ['Mutua buena', 'Otro sin país'] },
      },
    });
  });

  it('CHECK de vigencia: validTo anterior a validFrom se rechaza; igual o sin validTo vale', async () => {
    await expect(
      raw.patientCoverage.create({
        data: coverage(a, a.patients[0], {
          validFrom: new Date('2026-05-10'),
          validTo: new Date('2026-05-09'),
        }),
      }),
    ).rejects.toThrow(/patient_coverages_valid_range_check/);
    await raw.patientCoverage.create({
      data: coverage(a, a.patients[0], {
        validFrom: new Date('2026-05-10'),
        validTo: new Date('2026-05-10'),
      }),
    });
    await raw.patientCoverage.create({
      data: coverage(a, a.patients[1], { validFrom: new Date('2026-05-10') }),
    });
  });

  it('una sola cobertura principal viva por paciente (23505); retirada la primera, otra vale', async () => {
    const first = await asA((tx) =>
      tx.patientCoverage.create({
        data: coverage(a, a.patients[0], { isPrimary: true }),
      }),
    );
    await expect(
      asA((tx) =>
        tx.patientCoverage.create({
          data: coverage(a, a.patients[0], { isPrimary: true }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      raw.$executeRaw`INSERT INTO patient_coverages
        ("id", "tenantId", "patientId", "payerId", "isPrimary", "updatedAt")
        VALUES (gen_random_uuid(), ${a.tenantId}::uuid, ${a.patients[0]}::uuid,
                ${a.payerId}::uuid, true, now())`,
    ).rejects.toThrow(/23505|patient_coverages_one_primary_key/);

    await asA((tx) =>
      tx.patientCoverage.update({
        where: { id: first.id },
        data: { deletedAt: new Date() },
      }),
    );
    await asA((tx) =>
      tx.patientCoverage.create({
        data: coverage(a, a.patients[0], { isPrimary: true }),
      }),
    );
    // Varias NO principales sí caben.
    await asA((tx) =>
      tx.patientCoverage.createMany({
        data: [coverage(a, a.patients[0]), coverage(a, a.patients[0])],
      }),
    );
  });

  describe('relleno de insurerEps', () => {
    let bf: { a: string[]; b: string };
    const longText = 'X'.repeat(300);

    beforeAll(async () => {
      keepCoverages = true;
      await raw.patientCoverage.deleteMany({
        where: { tenantId: { in: [a.tenantId, b.tenantId] } },
      });
      await raw.payer.deleteMany({
        where: { tenantId: { in: [a.tenantId, b.tenantId] } },
      });
      await raw.patient.deleteMany({
        where: { tenantId: { in: [a.tenantId, b.tenantId] } },
      });
      const mk = async (
        clinic: Clinic,
        firstName: string,
        insurerEps: string | null,
        createdAt: Date,
        archived = false,
      ) =>
        (
          await raw.patient.create({
            data: {
              tenantId: clinic.tenantId,
              firstName,
              lastName: 'Relleno',
              insurerEps,
              createdAt,
              ...(archived ? { deletedAt: new Date() } : {}),
            },
          })
        ).id;
      const ids = [
        await mk(a, 'P1', 'Sura EPS', new Date('2026-01-02')),
        await mk(a, 'P2', '  sura eps ', new Date('2026-01-01')),
        await mk(a, 'P3', '   ', new Date('2026-01-03')),
        await mk(a, 'P4', null, new Date('2026-01-04')),
        await mk(a, 'P5', 'Colsanitas', new Date('2026-01-05'), true),
        await mk(a, 'P6', longText, new Date('2026-01-06')),
      ];
      bf = { a: ids, b: await mk(b, 'PB', 'Sura EPS', new Date('2026-01-01')) };
      await runBackfill();
    });

    afterAll(async () => {
      keepCoverages = false;
      await raw.patientCoverage.deleteMany({
        where: { tenantId: { in: [a.tenantId, b.tenantId] } },
      });
      await raw.payer.deleteMany({
        where: { tenantId: { in: [a.tenantId, b.tenantId] } },
      });
    });

    const payersOf = (tenantId: string) =>
      raw.payer.findMany({ where: { tenantId }, orderBy: { name: 'asc' } });

    it('un pagador por texto normalizado, con el texto del paciente más antiguo, tipo OTRO y sin país', async () => {
      const payers = await payersOf(a.tenantId);
      // El más antiguo con esa clave es P2 («  sura eps »), sin espacios.
      expect(payers.map((p) => p.name).sort()).toEqual(
        ['Colsanitas', 'X'.repeat(120), 'sura eps'].sort(),
      );
      for (const p of payers) {
        expect(p.type).toBe('OTRO');
        expect(p.country).toBeNull();
        expect(p.active).toBe(true);
      }
    });

    it('una cobertura principal migrada por paciente con texto (archivado incluido); vacío o nulo, ninguna', async () => {
      const cov = await raw.patientCoverage.findMany({
        where: { tenantId: a.tenantId },
      });
      expect(cov.map((c) => c.patientId).sort()).toEqual(
        [bf.a[0], bf.a[1], bf.a[4], bf.a[5]].sort(),
      );
      for (const c of cov) {
        expect(c.isPrimary).toBe(true);
        expect(c.migratedFromInsurerEps).toBe(true);
        expect(c.planName).toBeNull();
        expect(c.memberNumber).toBeNull();
        expect(c.validFrom).toBeNull();
      }
      const sura = (await payersOf(a.tenantId)).find((p) =>
        p.name.toLowerCase().startsWith('sura'),
      );
      const bySura = cov.filter((c) => c.payerId === sura?.id);
      expect(bySura.map((c) => c.patientId).sort()).toEqual(
        [bf.a[0], bf.a[1]].sort(),
      );
    });

    it('otra clínica con la misma cadena tiene su propio pagador', async () => {
      const pa = await payersOf(a.tenantId);
      const pb = await payersOf(b.tenantId);
      expect(pb).toHaveLength(1);
      expect(pb[0].name).toBe('Sura EPS');
      expect(pa.map((p) => p.id)).not.toContain(pb[0].id);
      const covB = await raw.patientCoverage.findMany({
        where: { tenantId: b.tenantId },
      });
      expect(covB).toHaveLength(1);
      expect(covB[0].payerId).toBe(pb[0].id);
      expect(covB[0].patientId).toBe(bf.b);
    });

    it('el texto de 300 caracteres da un nombre de 120', async () => {
      const names = (await payersOf(a.tenantId)).map((p) => p.name);
      expect(names).toContain('X'.repeat(120));
    });

    it('una segunda ejecución no duplica nada y insurerEps queda intacto', async () => {
      const before = [
        await raw.payer.count({
          where: { tenantId: { in: [a.tenantId, b.tenantId] } },
        }),
        await raw.patientCoverage.count({
          where: { tenantId: { in: [a.tenantId, b.tenantId] } },
        }),
      ];
      await runBackfill();
      const after = [
        await raw.payer.count({
          where: { tenantId: { in: [a.tenantId, b.tenantId] } },
        }),
        await raw.patientCoverage.count({
          where: { tenantId: { in: [a.tenantId, b.tenantId] } },
        }),
      ];
      expect(after).toEqual(before);
      expect(before).toEqual([4, 5]);
      const texts = await raw.patient.findMany({
        where: { id: { in: [...bf.a, bf.b] } },
        select: { firstName: true, insurerEps: true },
      });
      const byName = Object.fromEntries(
        texts.map((t) => [t.firstName, t.insurerEps]),
      );
      expect(byName).toMatchObject({
        P1: 'Sura EPS',
        P2: '  sura eps ',
        P3: '   ',
        P4: null,
        P5: 'Colsanitas',
        P6: longText,
        PB: 'Sura EPS',
      });
    });
  });

  describe('relleno de insurerEps: clave única y reutilización', () => {
    const tenants = () => ({ in: [a.tenantId, b.tenantId] });

    async function wipe(): Promise<void> {
      await raw.patientCoverage.deleteMany({ where: { tenantId: tenants() } });
      await raw.payer.deleteMany({ where: { tenantId: tenants() } });
      await raw.patient.deleteMany({ where: { tenantId: tenants() } });
    }

    beforeAll(async () => {
      keepCoverages = true;
      await wipe();
    });

    afterAll(async () => {
      await wipe();
      keepCoverages = false;
    });

    const mkPatient = async (
      clinic: Clinic,
      firstName: string,
      insurerEps: string,
    ) =>
      (
        await raw.patient.create({
          data: {
            tenantId: clinic.tenantId,
            firstName,
            lastName: 'Clave',
            insurerEps,
          },
        })
      ).id;

    it('dos textos de 121 caracteres que solo difieren en mayúsculas dan UN pagador y dos coberturas', async () => {
      const p1 = await mkPatient(b, 'L1', 'Y'.repeat(121));
      const p2 = await mkPatient(b, 'L2', 'y'.repeat(121));
      await runBackfill();
      const payers = await raw.payer.findMany({
        where: { tenantId: b.tenantId },
      });
      expect(payers).toHaveLength(1);
      expect(payers[0].name).toHaveLength(120);
      const cov = await raw.patientCoverage.findMany({
        where: { tenantId: b.tenantId },
      });
      expect(cov.map((c) => c.patientId).sort()).toEqual([p1, p2].sort());
      expect(cov.every((c) => c.payerId === payers[0].id)).toBe(true);
    });

    it('un pagador vivo con la misma clave en otra caja se reutiliza: no se crea otro', async () => {
      const existing = await raw.payer.create({
        data: {
          tenantId: a.tenantId,
          name: 'SURA EPS',
          type: 'EPS_CO',
          country: 'CO',
        },
      });
      const patientId = await mkPatient(a, 'R1', 'Sura EPS');
      await runBackfill();
      const payers = await raw.payer.findMany({
        where: { tenantId: a.tenantId },
      });
      expect(payers.map((p) => p.id)).toEqual([existing.id]);
      expect(payers[0].type).toBe('EPS_CO');
      const cov = await raw.patientCoverage.findMany({
        where: { tenantId: a.tenantId },
      });
      expect(cov).toHaveLength(1);
      expect(cov[0].patientId).toBe(patientId);
      expect(cov[0].payerId).toBe(existing.id);
    });
  });

  describe('carrera de la cobertura principal', () => {
    const repo = new PrismaPatientCoverageRepository(prisma, tenantContext);

    /** Espera a que `n` sesiones estén bloqueadas esperando un lock de fila. */
    async function waitForBlocked(n: number): Promise<void> {
      for (let i = 0; i < 200; i++) {
        const [{ blocked }] = await raw.$queryRaw<{ blocked: number }[]>`
          SELECT count(*)::int AS blocked FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND query ILIKE '%patient_coverages%'`;
        if (blocked >= n) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('las dos escrituras no llegaron a bloquearse');
    }

    it('dos setPrimary a la vez: una gana, la otra recibe 422 y queda exactamente una principal', async () => {
      // Los bloques del relleno borran los pacientes sembrados: uno propio.
      const patientId = (
        await raw.patient.create({
          data: {
            tenantId: a.tenantId,
            firstName: 'Carrera',
            lastName: 'Principal',
          },
        })
      ).id;
      if (!(await raw.payer.findFirst({ where: { id: a.payerId } }))) {
        a.payerId = (
          await raw.payer.create({
            data: {
              tenantId: a.tenantId,
              name: 'Pagador carrera',
              type: 'OTRO',
            },
          })
        ).id;
      }
      const held = await raw.patientCoverage.create({
        data: coverage(a, patientId, { isPrimary: true }),
      });
      const x = await raw.patientCoverage.create({
        data: coverage(a, patientId),
      });
      const y = await raw.patientCoverage.create({
        data: coverage(a, patientId),
      });

      // Un lock de fila sobre la principal actual deja a las dos escrituras
      // con su foto previa a la otra: sin él, el orden de los viajes decide si
      // la segunda ve la marca de la primera y la carrera no se produce.
      let release!: () => void;
      let locked!: () => void;
      const lockTaken = new Promise<void>((r) => (locked = r));
      const lockReleased = new Promise<void>((r) => (release = r));
      const holder = raw.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM patient_coverages WHERE id = ${held.id}::uuid FOR UPDATE`;
          locked();
          await lockReleased;
        },
        { timeout: 30_000 },
      );
      await lockTaken;

      const run = (coverageId: string) =>
        tenantContext.run(a.tenantId, () =>
          repo.setPrimary(patientId, coverageId, randomUUID()),
        );
      const both = Promise.allSettled([run(x.id), run(y.id)]);
      await waitForBlocked(2);
      release();
      await holder;
      const results = await both;

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({
        status: 422,
        message:
          'Otra petición acaba de cambiar la cobertura principal; vuelve a intentarlo.',
      });

      const primaries = await raw.patientCoverage.findMany({
        where: { patientId, isPrimary: true, deletedAt: null },
      });
      expect(primaries).toHaveLength(1);
      expect([x.id, y.id]).toContain(primaries[0].id);
    });
  });

  it('los FORCE se restauran tras el relleno', async () => {
    const rows = await raw.$queryRaw<{ relname: string; force: boolean }[]>`
      SELECT relname, relforcerowsecurity AS force FROM pg_class
       WHERE relname IN ('patients', 'payers', 'patient_coverages')`;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.force)).toBe(true);
  });
});
