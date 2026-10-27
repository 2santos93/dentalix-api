import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPerioExamRepository } from '../src/modules/periodontal/infrastructure/repositories/prisma-perio-exam.repository';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-007, capa DB de perio_exams / perio_site_measures / perio_tooth_measures.
// Cada caso escribe POR LA MISMA RUTA que la app (runWithTenant, rol
// dentalix_app, sujeto a RLS); `raw` (DIRECT_URL, owner) solo siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

interface Seeded {
  tenantId: string;
  patientId: string;
  userId: string;
  draftId: string;
  finalId: string;
}

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const patient = await raw.patient.create({
    data: { tenantId, firstName: 'Ana', lastName: subdomain },
  });
  const user = await raw.user.create({
    data: {
      email: `perio@${subdomain}.test`,
      passwordHash: 'x',
      fullName: 'Dra. Perio',
    },
  });
  const base = {
    tenantId,
    patientId: patient.id,
    providerId: user.id,
    examDate: new Date('2026-10-01T00:00:00.000Z'),
  };
  const draft = await raw.perioExam.create({ data: base });
  const final = await raw.perioExam.create({
    data: { ...base, status: 'FINAL', finalizedAt: new Date() },
  });
  return {
    tenantId,
    patientId: patient.id,
    userId: user.id,
    draftId: draft.id,
    finalId: final.id,
  };
}

async function cleanup(seeds: Seeded[]): Promise<void> {
  const tenantIds = seeds.map((s) => s.tenantId);
  // Sin `app.current_tenant` (conexión owner): los triggers dejan borrar.
  await raw.locationSchedule.deleteMany({
    where: { tenantId: { in: tenantIds } },
  });
  await raw.location.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await raw.perioExam.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await raw.patient.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await raw.user.deleteMany({
    where: { id: { in: seeds.map((s) => s.userId) } },
  });
  await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

describe('perio_*: FK compuestas, RLS, inmutabilidad y CHECKs (DX-007, int)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    await prisma.onModuleInit();
    a = await seedClinic('perio-int-a');
    b = await seedClinic('perio-int-b');
  });

  afterAll(async () => {
    await cleanup([a, b]);
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  function asA<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(a.tenantId, fn);
  }

  it('RLS: la clínica A no ve exámenes ni medidas de B', async () => {
    await raw.perioSiteMeasure.create({
      data: {
        tenantId: b.tenantId,
        examId: b.draftId,
        toothFdi: 16,
        site: 'MB',
        probingMm: 4,
      },
    });
    const seen = await asA(async (tx) => ({
      exams: await tx.perioExam.findMany({ select: { id: true } }),
      sites: await tx.perioSiteMeasure.findMany(),
    }));
    expect(seen.exams.map((e) => e.id).sort()).toEqual(
      [a.draftId, a.finalId].sort(),
    );
    expect(seen.sites).toEqual([]);
  });

  it('RLS: no deja insertar con el tenantId de otra clínica', async () => {
    await expect(
      asA((tx) =>
        tx.perioExam.create({
          data: {
            tenantId: b.tenantId,
            patientId: b.patientId,
            providerId: a.userId,
            examDate: new Date(),
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('FK compuesta: un examen de A no puede apuntar a un paciente de B', async () => {
    await expect(
      raw.perioExam.create({
        data: {
          tenantId: a.tenantId,
          patientId: b.patientId,
          providerId: a.userId,
          examDate: new Date(),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('FK compuesta: una medida de A no puede colgar de un examen de B', async () => {
    await expect(
      raw.perioSiteMeasure.create({
        data: {
          tenantId: a.tenantId,
          examId: b.draftId,
          toothFdi: 11,
          site: 'B',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('un examen FINAL no se modifica ni recibe medidas dentro de la app', async () => {
    await expect(
      asA((tx) =>
        tx.perioExam.update({ where: { id: a.finalId }, data: { notes: 'x' } }),
      ),
    ).rejects.toThrow(/finalizado/);
    await expect(
      asA((tx) =>
        tx.perioSiteMeasure.create({
          data: {
            tenantId: a.tenantId,
            examId: a.finalId,
            toothFdi: 11,
            site: 'B',
            probingMm: 3,
          },
        }),
      ),
    ).rejects.toThrow(/finalizado/);
    await expect(
      asA((tx) =>
        tx.perioToothMeasure.create({
          data: {
            tenantId: a.tenantId,
            examId: a.finalId,
            toothFdi: 11,
            mobility: 1,
          },
        }),
      ),
    ).rejects.toThrow(/finalizado/);
  });

  it('no deja sacar una medida de un examen FINAL moviéndola a otro examen', async () => {
    const draft2 = await raw.perioExam.create({
      data: {
        tenantId: a.tenantId,
        patientId: a.patientId,
        providerId: a.userId,
        examDate: new Date('2026-10-02T00:00:00.000Z'),
      },
    });
    // Sembrada como owner (sin contexto de tenant: el trigger no aplica).
    const measure = await raw.perioSiteMeasure.create({
      data: {
        tenantId: a.tenantId,
        examId: a.finalId,
        toothFdi: 21,
        site: 'MB',
        probingMm: 5,
      },
    });
    await expect(
      asA((tx) =>
        tx.perioSiteMeasure.update({
          where: { id: measure.id },
          data: { examId: draft2.id },
        }),
      ),
    ).rejects.toThrow(/finalizado/);
    const tooth = await raw.perioToothMeasure.create({
      data: {
        tenantId: a.tenantId,
        examId: a.finalId,
        toothFdi: 21,
        mobility: 1,
      },
    });
    await expect(
      asA((tx) =>
        tx.perioToothMeasure.update({
          where: { id: tooth.id },
          data: { examId: draft2.id },
        }),
      ),
    ).rejects.toThrow(/finalizado/);
  });

  it('el repositorio toma la zona horaria de la sede activa', async () => {
    // G1: la zona es de la sede (`Location.timeZone`), no de su horario.
    const location = await raw.location.create({
      data: locationData(REGIONAL_BOGOTA_FIXTURE, {
        tenantId: a.tenantId,
        name: 'Sede Madrid',
        country: 'ES',
        timeZone: 'Europe/Madrid',
      }),
    });
    const repo = new PrismaPerioExamRepository(prisma, tenantContext);
    await expect(
      tenantContext.run(a.tenantId, location.id, () => repo.clinicTimeZone()),
    ).resolves.toBe('Europe/Madrid');
    // Sin sede activa: la zona por defecto.
    await expect(
      tenantContext.run(a.tenantId, undefined, () => repo.clinicTimeZone()),
    ).resolves.toBe('America/Bogota');
  });

  it('un DRAFT sí admite medidas y se puede finalizar', async () => {
    await asA((tx) =>
      tx.perioSiteMeasure.create({
        data: {
          tenantId: a.tenantId,
          examId: a.draftId,
          toothFdi: 11,
          site: 'B',
          probingMm: 3,
        },
      }),
    );
    const final = await asA((tx) =>
      tx.perioExam.update({
        where: { id: a.draftId },
        data: { status: 'FINAL', finalizedAt: new Date() },
      }),
    );
    expect(final.status).toBe('FINAL');
  });

  it('CHECK: rangos, FDI y coherencia FINAL/finalizedAt', async () => {
    const site = {
      tenantId: b.tenantId,
      examId: b.draftId,
      site: 'L' as const,
    };
    await expect(
      raw.perioSiteMeasure.create({ data: { ...site, toothFdi: 19 } }),
    ).rejects.toThrow(/perio_site_measures_tooth_check/);
    await expect(
      raw.perioSiteMeasure.create({
        data: { ...site, toothFdi: 21, probingMm: 20 },
      }),
    ).rejects.toThrow(/perio_site_measures_probing_check/);
    await expect(
      raw.perioSiteMeasure.create({
        data: { ...site, toothFdi: 21, recessionMm: -6 },
      }),
    ).rejects.toThrow(/perio_site_measures_recession_check/);
    await expect(
      raw.perioToothMeasure.create({
        data: {
          tenantId: b.tenantId,
          examId: b.draftId,
          toothFdi: 21,
          mobility: 4,
        },
      }),
    ).rejects.toThrow(/perio_tooth_measures_mobility_check/);
    await expect(
      raw.perioExam.update({
        where: { id: b.draftId },
        data: { status: 'FINAL' },
      }),
    ).rejects.toThrow(/perio_exams_finalized_check/);
  });
});
