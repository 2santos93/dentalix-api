import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaAuthRepository } from '../src/modules/auth/infrastructure/repositories/prisma-auth.repository';
import { PrismaPatientRepository } from '../src/modules/patients/infrastructure/repositories/prisma-patient.repository';
import { assertNotUnderRetention } from '../src/modules/patients/application/retention-guard';
import { ListRetentionExpiringUseCase } from '../src/modules/patients/application/use-cases/retention.use-cases';
import { REGIONAL_BOGOTA_FIXTURE } from './support/location-fixtures';
import { purgeTenants } from './support/tenant-purge';

// DX-330: el plazo de conservación de la HC es una columna de la clínica
// (`clinicalRecordRetentionYears`, CHECK 15..100) con su ventana de corrección
// (`RaisedAt` + `YearsBeforeRaise`, CHECK de media ventana). Esta capa DB
// comprueba el alta de la clínica con el mínimo de plataforma y los dos CHECK,
// por la misma ruta que la app (rol dentalix_app) y con el owner (`raw`).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUFFIX = `${process.pid}-${Date.now()}`;
let tenantA: string;
let tenantB: string;
const created: { tenantId: string; userId: string }[] = [];

function termOf(tenantId: string): Promise<number> {
  return raw.tenant
    .findUniqueOrThrow({
      where: { id: tenantId },
      select: { clinicalRecordRetentionYears: true },
    })
    .then((t) => t.clinicalRecordRetentionYears);
}

describe('plazo de conservación de la HC por clínica (DX-330, int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    tenantA = (
      await raw.tenant.create({
        data: { name: 'dx330-a', subdomain: `dx330-t1-a-${SUFFIX}` },
      })
    ).id;
    tenantB = (
      await raw.tenant.create({
        data: { name: 'dx330-b', subdomain: `dx330-t1-b-${SUFFIX}` },
      })
    ).id;
  });

  afterAll(async () => {
    // La clínica del alta lleva sede, membresía, catálogo y auditoría: se
    // borra con el catálogo de tablas de clínica (DX-396), y luego su usuario.
    await purgeTenants(raw, [
      tenantA,
      tenantB,
      ...created.map((c) => c.tenantId),
    ]);
    await raw.user.deleteMany({
      where: { id: { in: created.map((c) => c.userId) } },
    });
  });

  it('a new clinic starts at the platform minimum', async () => {
    const repo = new PrismaAuthRepository(prisma, { platformMinYears: 20 });
    const clinic = await repo.createClinicWithOwner({
      clinicName: 'dx330 alta',
      subdomain: `dx330-t1-alta-${SUFFIX}`,
      email: `dx330-t1-${SUFFIX}@example.com`,
      passwordHash: 'x',
      fullName: 'Dra. Plazo',
      emailVerifiedAt: new Date('2026-11-01T12:00:00Z'),
      location: {
        country: REGIONAL_BOGOTA_FIXTURE.country,
        currency: REGIONAL_BOGOTA_FIXTURE.currency,
        timeZone: REGIONAL_BOGOTA_FIXTURE.timeZone,
        locale: REGIONAL_BOGOTA_FIXTURE.locale,
        hourCycle: REGIONAL_BOGOTA_FIXTURE.hourCycle,
      },
      request: null,
    });
    created.push(clinic);
    expect(await termOf(clinic.tenantId)).toBe(20);
    // Las clínicas anteriores no cambian: el default de la BD es el suelo.
    expect(await termOf(tenantA)).toBe(15);
    expect(await termOf(tenantB)).toBe(15);
  });

  it('the database rejects a term outside 15..100 and a half-open window', async () => {
    const setTerm = (id: string, years: number) =>
      raw.$executeRaw`UPDATE "tenants" SET "clinicalRecordRetentionYears" = ${years} WHERE "id" = ${id}::uuid`;
    await expect(setTerm(tenantA, 14)).rejects.toThrow(
      /tenants_clinical_record_retention_years_check/,
    );
    await expect(setTerm(tenantA, 101)).rejects.toThrow(
      /tenants_clinical_record_retention_years_check/,
    );
    await expect(
      raw.$executeRaw`UPDATE "tenants" SET "clinicalRecordRetentionRaisedAt" = now() WHERE "id" = ${tenantA}::uuid`,
    ).rejects.toThrow(/tenants_clinical_record_retention_raise_check/);
    await expect(
      raw.$executeRaw`UPDATE "tenants" SET "clinicalRecordRetentionYearsBeforeRaise" = 15 WHERE "id" = ${tenantA}::uuid`,
    ).rejects.toThrow(/tenants_clinical_record_retention_raise_check/);
    // Los extremos y una ventana completa sí entran.
    await setTerm(tenantA, 100);
    await raw.$executeRaw`UPDATE "tenants" SET "clinicalRecordRetentionYears" = 20, "clinicalRecordRetentionRaisedAt" = now(), "clinicalRecordRetentionYearsBeforeRaise" = 15 WHERE "id" = ${tenantA}::uuid`;
    expect(await termOf(tenantA)).toBe(20);
  });
});

describe('el plazo de la clínica manda en la fecha de fin (DX-330, int)', () => {
  const NOW = new Date('2026-11-01T12:00:00Z');
  const LAST = new Date('2010-06-15T10:00:00Z');
  const repo = new PrismaPatientRepository(prisma, tenantContext, {
    platformMinYears: 15,
  });
  let clinicA: string;
  let clinicB: string;
  let actorId: string;

  function revocation(tenantId: string) {
    return {
      now: NOW,
      ctx: {
        tenantId,
        locationId: null,
        actor: { userId: actorId, role: 'ADMIN' as const },
        requestId: null,
        ip: null,
        userAgent: null,
      },
    };
  }

  function archive(
    tenantId: string,
    id: string,
    patients: PrismaPatientRepository = repo,
  ) {
    return tenantContext.run(tenantId, () =>
      patients.archive(
        id,
        (state) => assertNotUnderRetention(state, NOW),
        revocation(tenantId),
      ),
    );
  }

  function attended(
    tenantId: string,
    firstName: string,
    lastAttentionAt: Date = LAST,
  ): Promise<string> {
    return raw.patient
      .create({
        data: { tenantId, firstName, lastName: 'DX330', lastAttentionAt },
      })
      .then((p) => p.id);
  }

  beforeAll(async () => {
    actorId = (
      await raw.user.create({
        data: {
          email: `dx330-t3-${SUFFIX}@example.com`,
          passwordHash: 'x',
          fullName: 'Dra. Plazo',
        },
      })
    ).id;
    clinicA = (
      await raw.tenant.create({
        data: { name: 'dx330-t3-a', subdomain: `dx330-t3-a-${SUFFIX}` },
      })
    ).id;
    clinicB = (
      await raw.tenant.create({
        data: { name: 'dx330-t3-b', subdomain: `dx330-t3-b-${SUFFIX}` },
      })
    ).id;
  });

  beforeEach(async () => {
    await raw.$executeRaw`UPDATE "tenants" SET "clinicalRecordRetentionYears" = 15 WHERE "id" = ${clinicA}::uuid`;
    await raw.$executeRaw`UPDATE "tenants" SET "clinicalRecordRetentionYears" = 25 WHERE "id" = ${clinicB}::uuid`;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await purgeTenants(raw, [clinicA, clinicB]);
    await raw.user.delete({ where: { id: actorId } });
    await raw.$disconnect();
    await prisma.$disconnect();
  });

  it('two clinics, two terms', async () => {
    const inA = await attended(clinicA, 'Ana');
    const inB = await attended(clinicB, 'Bea');

    const seenInA = await tenantContext.run(clinicA, () => repo.findById(inA));
    expect(seenInA).toMatchObject({
      retentionUntil: '2025-06-15',
      underRetention: false,
      clinicRetentionYears: 15,
      retentionFromPreviousTerm: false,
    });
    const seenInB = await tenantContext.run(clinicB, () => repo.findById(inB));
    expect(seenInB).toMatchObject({
      retentionUntil: '2035-06-15',
      underRetention: true,
      clinicRetentionYears: 25,
    });

    const listedInB = await tenantContext.run(clinicB, () =>
      repo.list({ query: 'Bea' }),
    );
    expect(listedInB.items.find((p) => p.id === inB)).toMatchObject({
      retentionUntil: '2035-06-15',
      clinicRetentionYears: 25,
    });
    const listedInA = await tenantContext.run(clinicA, () => repo.list({}));
    expect(listedInA.items.find((p) => p.id === inA)).toMatchObject({
      retentionUntil: '2025-06-15',
      clinicRetentionYears: 15,
    });

    await expect(archive(clinicB, inB)).rejects.toMatchObject({
      response: {
        code: 'CLINICAL_RECORD_RETENTION',
        retentionUntil: '2035-06-15',
        message: expect.stringContaining('25 años') as string,
      },
    });
    await expect(archive(clinicA, inA)).resolves.toBeUndefined();
  });

  it('raising the stored term applies at once', async () => {
    const id = await attended(clinicA, 'Sube');
    await raw.$executeRaw`UPDATE "tenants" SET "clinicalRecordRetentionYears" = 20 WHERE "id" = ${clinicA}::uuid`;

    expect(
      await tenantContext.run(clinicA, () => repo.findById(id)),
    ).toMatchObject({
      retentionUntil: '2030-06-15',
      underRetention: true,
      clinicRetentionYears: 20,
    });
    await expect(archive(clinicA, id)).rejects.toMatchObject({
      response: {
        code: 'CLINICAL_RECORD_RETENTION',
        retentionUntil: '2030-06-15',
      },
    });
  });

  it('the platform minimum wins over the stored term', async () => {
    const raised = new PrismaPatientRepository(prisma, tenantContext, {
      platformMinYears: 20,
    });
    const id = await attended(clinicA, 'Minimo');

    expect(
      await tenantContext.run(clinicA, () => raised.findById(id)),
    ).toMatchObject({
      retentionUntil: '2030-06-15',
      underRetention: true,
      clinicRetentionYears: 20,
    });
    await expect(archive(clinicA, id, raised)).rejects.toMatchObject({
      response: { retentionUntil: '2030-06-15' },
    });
  });

  it('a floor keeps a patient out of the expiring list', async () => {
    // B ya redujo a 15: con su plazo de 25 el paciente de 2005 ni estaría.
    await raw.$executeRaw`UPDATE "tenants" SET "clinicalRecordRetentionYears" = 15 WHERE "id" = ${clinicB}::uuid`;
    const id = await attended(
      clinicB,
      'Suelo',
      new Date('2005-03-10T10:00:00Z'),
    );
    const useCase = new ListRetentionExpiringUseCase(repo, () => NOW);
    const expiring = () =>
      tenantContext.run(clinicB, () =>
        useCase.execute({ withinDays: 365, page: 1, pageSize: 50 }),
      );

    const without = await expiring();
    expect(without.items.find((p) => p.id === id)).toMatchObject({
      retentionUntil: '2020-03-10',
    });

    await raw.$executeRaw`UPDATE "patients" SET "retention_floor_until" = DATE '2030-03-10' WHERE "id" = ${id}::uuid`;
    const floored = await expiring();
    expect(floored.items.map((p) => p.id)).not.toContain(id);
    expect(floored.total).toBe(without.total - 1);

    // El suelo que vence dentro del horizonte vuelve a la lista, con su fecha.
    await raw.$executeRaw`UPDATE "patients" SET "retention_floor_until" = DATE '2027-03-10' WHERE "id" = ${id}::uuid`;
    const soon = await expiring();
    expect(soon.items.find((p) => p.id === id)).toMatchObject({
      retentionUntil: '2027-03-10',
      retentionFromPreviousTerm: true,
    });
  });

  it('reads the clinic term once per call', async () => {
    for (const name of ['Uno', 'Dos', 'Tres']) {
      await attended(clinicA, `Una lectura ${name}`);
    }
    let reads = 0;
    const counting = {
      runWithTenant: <T>(
        work: (tx: Prisma.TransactionClient) => Promise<T>,
      ): Promise<T> =>
        prisma.runWithTenant((tx) =>
          work(
            new Proxy(tx, {
              get(target, key, receiver): unknown {
                if (key !== 'tenant') return Reflect.get(target, key, receiver);
                const spied = target.tenant;
                return {
                  ...spied,
                  findUniqueOrThrow: (
                    args: Prisma.TenantFindUniqueOrThrowArgs,
                  ) => {
                    reads += 1;
                    return spied.findUniqueOrThrow(args);
                  },
                };
              },
            }),
          ),
        ),
    };
    const spiedRepo = new PrismaPatientRepository(
      counting as never,
      tenantContext,
      { platformMinYears: 15 },
    );

    const { items } = await tenantContext.run(clinicA, () =>
      spiedRepo.list({ query: 'U' }),
    );

    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(reads).toBe(1);
  });
});
