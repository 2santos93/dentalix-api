import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, RetentionExtension } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaAuthRepository } from '../src/modules/auth/infrastructure/repositories/prisma-auth.repository';
import { PrismaPatientRepository } from '../src/modules/patients/infrastructure/repositories/prisma-patient.repository';
import {
  PrismaClinicRetentionSettingsRepository,
  retentionCandidates,
} from '../src/modules/patients/infrastructure/repositories/prisma-clinic-retention-settings.repository';
import {
  assertNotUnderRetention,
  assertUnderRetention,
} from '../src/modules/patients/application/retention-guard';
import { floorCandidate } from '../src/modules/patients/domain/retention/clinical-record-retention';
import { ListRetentionExpiringUseCase } from '../src/modules/patients/application/use-cases/retention.use-cases';
import { REGIONAL_BOGOTA_FIXTURE } from './support/location-fixtures';
import {
  gate,
  settle,
  transactionId,
  waitForTransactionWaiters,
} from './support/postgres-concurrency';
import { fixedSedeDay } from './support/sede-clock';
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

afterAll(async () => {
  await raw.$disconnect();
  await prisma.$disconnect();
});

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
  // `findById` y `list` miran el reloj real: las fechas salen del día de la
  // sede, para que 15 años estén siempre vencidos y 20 y 25, siempre en
  // retención.
  const NOW = fixedSedeDay().at;
  const LAST_YEAR = NOW.getUTCFullYear() - 16;
  const LAST = new Date(Date.UTC(LAST_YEAR, 5, 15, 10));
  const endWith = (years: number): string => `${LAST_YEAR + years}-06-15`;
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
  });

  it('two clinics, two terms', async () => {
    const inA = await attended(clinicA, 'Ana');
    const inB = await attended(clinicB, 'Bea');

    const seenInA = await tenantContext.run(clinicA, () => repo.findById(inA));
    expect(seenInA).toMatchObject({
      retentionUntil: endWith(15),
      underRetention: false,
      clinicRetentionYears: 15,
      retentionFromPreviousTerm: false,
    });
    const seenInB = await tenantContext.run(clinicB, () => repo.findById(inB));
    expect(seenInB).toMatchObject({
      retentionUntil: endWith(25),
      underRetention: true,
      clinicRetentionYears: 25,
    });

    const listedInB = await tenantContext.run(clinicB, () =>
      repo.list({ query: 'Bea' }),
    );
    expect(listedInB.items.find((p) => p.id === inB)).toMatchObject({
      retentionUntil: endWith(25),
      clinicRetentionYears: 25,
    });
    const listedInA = await tenantContext.run(clinicA, () => repo.list({}));
    expect(listedInA.items.find((p) => p.id === inA)).toMatchObject({
      retentionUntil: endWith(15),
      clinicRetentionYears: 15,
    });

    await expect(archive(clinicB, inB)).rejects.toMatchObject({
      response: {
        code: 'CLINICAL_RECORD_RETENTION',
        retentionUntil: endWith(25),
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
      retentionUntil: endWith(20),
      underRetention: true,
      clinicRetentionYears: 20,
    });
    await expect(archive(clinicA, id)).rejects.toMatchObject({
      response: {
        code: 'CLINICAL_RECORD_RETENTION',
        retentionUntil: endWith(20),
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
      retentionUntil: endWith(20),
      underRetention: true,
      clinicRetentionYears: 20,
    });
    await expect(archive(clinicA, id, raised)).rejects.toMatchObject({
      response: { retentionUntil: endWith(20) },
    });
  });

  it('a floor keeps a patient out of the expiring list', async () => {
    // B ya redujo a 15: con su plazo de 25 el paciente de 2005 ni estaría.
    const CLOCK = new Date('2026-11-01T12:00:00Z');
    await raw.$executeRaw`UPDATE "tenants" SET "clinicalRecordRetentionYears" = 15 WHERE "id" = ${clinicB}::uuid`;
    const id = await attended(
      clinicB,
      'Suelo',
      new Date('2005-03-10T10:00:00Z'),
    );
    const useCase = new ListRetentionExpiringUseCase(repo, () => CLOCK);
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

describe('cambiar el plazo: suelos, ventana y evento (DX-330, int)', () => {
  const T = new Date('2026-11-01T12:00:00Z');
  const TODAY = '2026-11-01';
  const HOUR = 60 * 60 * 1000;
  const after = (ms: number) => new Date(T.getTime() + ms);
  const patients = new PrismaPatientRepository(prisma, tenantContext, {
    platformMinYears: 15,
  });
  const settings = new PrismaClinicRetentionSettingsRepository(
    prisma,
    tenantContext,
    { platformMinYears: 15 },
  );
  const tenants: string[] = [];
  let actorId: string;
  let sequence = 0;

  function ctxOf(tenantId: string) {
    return {
      tenantId,
      locationId: null,
      actor: { userId: actorId, role: 'ADMIN' as const },
      requestId: null,
      ip: null,
      userAgent: null,
    };
  }

  async function clinicAt(years: number): Promise<string> {
    sequence += 1;
    const subdomain = `dx330-t4-${sequence}-${SUFFIX}`;
    const { id } = await raw.tenant.create({
      data: {
        name: subdomain,
        subdomain,
        clinicalRecordRetentionYears: years,
      },
    });
    tenants.push(id);
    return id;
  }

  function patientIn(
    tenantId: string,
    lastAttention: string | null,
    retentionExtended: RetentionExtension = 'NONE',
    deletedAt: Date | null = null,
  ): Promise<string> {
    return raw.patient
      .create({
        data: {
          tenantId,
          firstName: `Paciente ${lastAttention ?? 'sin atención'}`,
          lastName: 'DX330',
          lastAttentionAt: lastAttention
            ? new Date(`${lastAttention}T10:00:00Z`)
            : null,
          retentionExtended,
          deletedAt,
        },
      })
      .then((p) => p.id);
  }

  function put(tenantId: string, years: number, now: Date, confirm = true) {
    return tenantContext.run(tenantId, () =>
      settings.set(
        { clinicalRecordRetentionYears: years, confirmReduction: confirm },
        ctxOf(tenantId),
        now,
      ),
    );
  }

  function archive(tenantId: string, id: string, now: Date = T) {
    return tenantContext.run(tenantId, () =>
      patients.archive(id, (state) => assertNotUnderRetention(state, now), {
        now,
        ctx: ctxOf(tenantId),
      }),
    );
  }

  function view(tenantId: string, id: string) {
    return tenantContext.run(tenantId, () => patients.findById(id));
  }

  async function floorOf(id: string): Promise<string | null> {
    const row = await raw.patient.findUniqueOrThrow({
      where: { id },
      select: { retentionFloorUntil: true },
    });
    return row.retentionFloorUntil?.toISOString().slice(0, 10) ?? null;
  }

  function floorsIn(tenantId: string): Promise<number> {
    return raw.patient.count({
      where: { tenantId, retentionFloorUntil: { not: null } },
    });
  }

  function storedIn(tenantId: string) {
    return tenantContext.run(tenantId, () => settings.get());
  }

  function eventsIn(tenantId: string) {
    return raw.auditEvent.findMany({
      where: { tenantId, resourceType: 'CLINIC_SETTINGS' },
      orderBy: { occurredAt: 'asc' },
    });
  }

  /** R5 contado aparte, en TS, fila a fila y con la fecha de cada paciente. */
  async function protectedApart(
    tenantId: string,
    referenceYears: number,
    newYears: number,
  ): Promise<number> {
    const rows = await raw.patient.findMany({
      where: { tenantId, deletedAt: null, lastAttentionAt: { not: null } },
    });
    return rows.filter((p) => {
      const last = p.lastAttentionAt as Date;
      const end = Math.max(
        p.retentionFloorUntil?.getTime() ?? Number.NEGATIVE_INFINITY,
        floorCandidate(last, p.retentionExtended, referenceYears).getTime(),
      );
      return (
        end >= new Date(TODAY).getTime() &&
        end > floorCandidate(last, p.retentionExtended, newYears).getTime()
      );
    }).length;
  }

  beforeAll(async () => {
    actorId = (
      await raw.user.create({
        data: {
          email: `dx330-t4-${SUFFIX}@example.com`,
          passwordHash: 'x',
          fullName: 'Dra. Plazo',
        },
      })
    ).id;
  });

  afterAll(async () => {
    await purgeTenants(raw, tenants);
    await raw.user.delete({ where: { id: actorId } });
  });

  it('a confirmed reduction protects', async () => {
    const b = await clinicAt(25);
    const in2010 = await patientIn(b, '2010-06-15');
    const in2005 = await patientIn(b, '2005-06-15');
    const expired = await patientIn(b, '2001-10-31');
    const endsToday = await patientIn(b, '2001-11-01');
    const double = await patientIn(b, '1990-06-15', 'DOUBLE');
    const unseen = await patientIn(b, null);

    await expect(put(b, 15, T)).resolves.toEqual({
      outcome: 'APPLIED',
      stored: { years: 15, raisedAt: null, yearsBeforeRaise: null },
      protectedPatients: 4,
    });

    expect(await floorOf(in2010)).toBe('2035-06-15');
    expect(await floorOf(in2005)).toBe('2030-06-15');
    expect(await floorOf(expired)).toBeNull();
    expect(await floorOf(endsToday)).toBe(TODAY);
    expect(await floorOf(double)).toBe('2040-06-15');
    expect(await floorOf(unseen)).toBeNull();

    expect(await view(b, in2010)).toMatchObject({
      retentionUntil: '2035-06-15',
      retentionFromPreviousTerm: true,
      clinicRetentionYears: 15,
    });
    await expect(archive(b, in2010)).rejects.toMatchObject({
      response: {
        code: 'CLINICAL_RECORD_RETENTION',
        retentionUntil: '2035-06-15',
      },
    });
    await expect(archive(b, expired)).resolves.toBeUndefined();
    await expect(archive(b, endsToday)).rejects.toMatchObject({
      response: { retentionUntil: TODAY },
    });
    await expect(
      archive(b, endsToday, after(24 * HOUR)),
    ).resolves.toBeUndefined();

    await raw.patient.update({
      where: { id: unseen },
      data: { lastAttentionAt: new Date('2026-11-02T10:00:00Z') },
    });
    expect(await view(b, unseen)).toMatchObject({
      retentionUntil: '2041-11-02',
      retentionFromPreviousTerm: false,
    });
  });

  it('a floor blocks archive through the locked read', async () => {
    const a = await clinicAt(15);
    // Vencido con 15 (2025): solo el suelo, leído con el paciente bloqueado, lo
    // retiene. Sin atención posterior y sin reducción que lo escriba aquí.
    const id = await patientIn(a, '2010-06-15');
    await raw.$executeRaw`UPDATE "patients" SET "retention_floor_until" = DATE '2035-06-15' WHERE "id" = ${id}::uuid`;

    await expect(archive(a, id)).rejects.toMatchObject({
      response: {
        code: 'CLINICAL_RECORD_RETENTION',
        retentionUntil: '2035-06-15',
        message: expect.stringContaining(
          'plazo anterior de la clínica',
        ) as string,
      },
    });
    expect(
      await raw.patient.findUniqueOrThrow({
        where: { id },
        select: { deletedAt: true },
      }),
    ).toEqual({ deletedAt: null });

    await expect(
      archive(a, id, new Date('2035-06-16T12:00:00Z')),
    ).resolves.toBeUndefined();
  });

  it('an unconfirmed reduction writes nothing', async () => {
    const b = await clinicAt(25);
    const id = await patientIn(b, '2010-06-15');

    await expect(put(b, 15, T, false)).resolves.toEqual({
      outcome: 'CONFIRMATION_REQUIRED',
      previousYears: 25,
      newYears: 15,
      referenceYears: 25,
      protectedPatients: 1,
      withinCorrectionWindow: false,
    });

    expect(await floorOf(id)).toBeNull();
    expect((await storedIn(b)).years).toBe(25);
    expect(await eventsIn(b)).toEqual([]);
  });

  it('protectedPatients is the same before, after and counted apart', async () => {
    const b = await clinicAt(30);
    // 2010: con suelo tras la primera. 2000: su suelo de 2030 es lo único que
    // lo cuenta en la segunda, porque con 20 años ya venció en 2020.
    await patientIn(b, '2010-06-15');
    const onlyByFloor = await patientIn(b, '2000-06-15');
    await patientIn(b, '1990-06-15'); // vencido con 30: nunca cuenta
    await patientIn(b, null);

    const first = await protectedApart(b, 30, 20);
    await expect(put(b, 20, T, false)).resolves.toMatchObject({
      protectedPatients: first,
    });
    await expect(put(b, 20, T)).resolves.toMatchObject({
      outcome: 'APPLIED',
      protectedPatients: first,
    });
    expect(first).toBe(2);
    expect(await protectedApart(b, 30, 20)).toBe(first);

    const second = await protectedApart(b, 20, 15);
    expect(second).toBe(2);
    await expect(put(b, 15, T, false)).resolves.toMatchObject({
      protectedPatients: second,
    });
    await expect(put(b, 15, T)).resolves.toMatchObject({
      outcome: 'APPLIED',
      protectedPatients: second,
    });
    expect(await protectedApart(b, 20, 15)).toBe(second);
    expect(await floorOf(onlyByFloor)).toBe('2030-06-15');
    const [, event] = await eventsIn(b);
    expect(event.metadata).toMatchObject({
      retentionTermChange: { protectedPatients: second },
    });
  });

  it('clinic A does not change', async () => {
    const a = await clinicAt(25);
    const b = await clinicAt(25);
    const inA = await patientIn(a, '2010-06-15');
    await patientIn(b, '2010-06-15');

    await expect(put(b, 15, T)).resolves.toMatchObject({
      protectedPatients: 1,
    });

    expect(await floorOf(inA)).toBeNull();
    expect((await storedIn(a)).years).toBe(25);
    expect(await eventsIn(a)).toEqual([]);
  });

  it('the floor never drops', async () => {
    const b = await clinicAt(25);
    const lowered = await patientIn(b, '2010-06-15', 'DOUBLE');
    const twice = await patientIn(b, '2010-06-15');

    await put(b, 20, T);
    expect(await floorOf(lowered)).toBe('2060-06-15');
    expect(await floorOf(twice)).toBe('2035-06-15');

    await tenantContext.run(b, () =>
      patients.setRetentionExtension(lowered, {
        value: 'NONE',
        reason: 'Corrección de la ampliación',
        actorId,
      }),
    );
    expect(await floorOf(lowered)).toBe('2060-06-15');

    // Con referencia 20 el candidato es 2030: se conserva el mayor.
    await put(b, 15, T);
    expect(await floorOf(twice)).toBe('2035-06-15');
    expect(await floorOf(lowered)).toBe('2060-06-15');
  });

  it('a reduction floors a PERMANENT patient with m = 2 and it shows once lowered to NONE', async () => {
    const b = await clinicAt(25);
    const id = await patientIn(b, '2010-06-15', 'PERMANENT');

    await expect(put(b, 15, T)).resolves.toMatchObject({
      protectedPatients: 1,
    });

    expect(await floorOf(id)).toBe('2060-06-15');
    expect(await view(b, id)).toMatchObject({
      retentionExtended: 'PERMANENT',
      retentionUntil: null,
      underRetention: true,
    });
    await tenantContext.run(b, () =>
      patients.setRetentionExtension(id, {
        value: 'NONE',
        reason: 'Se retira la retención permanente',
        actorId,
      }),
    );
    expect(await view(b, id)).toMatchObject({
      retentionUntil: '2060-06-15',
      retentionFromPreviousTerm: true,
    });
  });

  it('a reduction neither floors nor counts an archived patient', async () => {
    const b = await clinicAt(25);
    const archived = await patientIn(b, '2010-06-15', 'NONE', T);
    const live = await patientIn(b, '2010-06-15');

    await expect(put(b, 15, T, false)).resolves.toMatchObject({
      protectedPatients: 1,
    });
    await expect(put(b, 15, T)).resolves.toMatchObject({
      protectedPatients: 1,
    });

    expect(await floorOf(archived)).toBeNull();
    expect(await floorOf(live)).toBe('2035-06-15');
  });

  it('partial suppression still applies to a patient held only by a floor', async () => {
    const b = await clinicAt(25);
    const held = await patientIn(b, '2010-06-15');
    const suppress = (tenantId: string, id: string) =>
      tenantContext.run(tenantId, () =>
        patients.partiallySuppress(id, {
          reason: 'Solicitud del paciente sobre sus datos',
          actorId,
          assertAllowed: (state) => assertUnderRetention(state, T),
        }),
      );
    await put(b, 15, T);
    // Con 15 años, 2010-06-15 vencería en 2025: solo el suelo lo mantiene.
    expect(await floorOf(held)).toBe('2035-06-15');

    const result = await suppress(b, held);
    expect(result.underRetention).toBe(true);
    expect(result.partiallySuppressedAt).toBeInstanceOf(Date);

    // Control: sin suelo (clínica que ya estaba en 15), la misma fecha ya no
    // está en retención y la supresión parcial se rechaza.
    const c = await clinicAt(15);
    const free = await patientIn(c, '2010-06-15');
    expect(await floorOf(free)).toBeNull();
    await expect(suppress(c, free)).rejects.toMatchObject({
      response: { code: 'NOT_UNDER_RETENTION' },
    });
  });

  it('a reduction does not bring the expiring list forward', async () => {
    const a = await clinicAt(15);
    const b = await clinicAt(25);
    await patientIn(a, '2005-06-15');
    const ids = [
      await patientIn(b, '2010-06-15'),
      await patientIn(b, '2005-06-15'),
      await patientIn(b, '1990-06-15', 'DOUBLE'),
    ];
    const useCase = new ListRetentionExpiringUseCase(patients, () => T);
    const expiring = () =>
      tenantContext.run(b, () =>
        useCase.execute({ withinDays: 365, page: 1, pageSize: 50 }),
      );

    expect((await expiring()).items).toEqual([]);
    await put(b, 15, T);
    expect(await floorsIn(b)).toBe(ids.length);

    expect((await expiring()).items).toEqual([]);
  });

  describe('a correction inside the window leaves no floors', () => {
    const IN_23H = after(23 * HOUR);

    it('going back to the previous term', async () => {
      const b = await clinicAt(20);
      await patientIn(b, '2010-06-15');
      await put(b, 30, T);

      await expect(put(b, 20, IN_23H, false)).resolves.toMatchObject({
        outcome: 'CONFIRMATION_REQUIRED',
        previousYears: 30,
        newYears: 20,
        referenceYears: 20,
        protectedPatients: 0,
        withinCorrectionWindow: true,
      });
      await expect(put(b, 20, IN_23H)).resolves.toEqual({
        outcome: 'APPLIED',
        stored: { years: 20, raisedAt: null, yearsBeforeRaise: null },
        protectedPatients: 0,
      });

      expect(await floorsIn(b)).toBe(0);
      const [, event] = await eventsIn(b);
      expect(event.metadata).toMatchObject({
        retentionTermChange: {
          direction: 'DOWN',
          withinCorrectionWindow: true,
        },
      });
    });

    it('staying above keeps the window, without extending it', async () => {
      const b = await clinicAt(20);
      await patientIn(b, '2010-06-15');
      await put(b, 30, T);

      await expect(put(b, 25, IN_23H)).resolves.toMatchObject({
        protectedPatients: 0,
      });
      expect(await floorsIn(b)).toBe(0);
      expect(await storedIn(b)).toEqual({
        years: 25,
        raisedAt: T,
        yearsBeforeRaise: 20,
      });

      await put(b, 20, after(23.5 * HOUR));
      expect(await floorsIn(b)).toBe(0);
      expect(await storedIn(b)).toEqual({
        years: 20,
        raisedAt: null,
        yearsBeforeRaise: null,
      });
    });

    it('going below protects with the previous term, never the raised one', async () => {
      const b = await clinicAt(20);
      const id = await patientIn(b, '2010-06-15');
      await put(b, 30, T);

      await expect(put(b, 15, IN_23H)).resolves.toMatchObject({
        protectedPatients: 1,
      });

      expect(await floorOf(id)).toBe('2030-06-15');
    });

    it('a floor from before the raise stays intact', async () => {
      const b = await clinicAt(20);
      const id = await patientIn(b, '2010-06-15');
      await raw.$executeRaw`UPDATE "patients" SET "retention_floor_until" = DATE '2038-03-10' WHERE "id" = ${id}::uuid`;
      await put(b, 30, T);

      await put(b, 20, IN_23H);

      expect(await floorOf(id)).toBe('2038-03-10');
    });

    it('while the window is open the raised term applies', async () => {
      const b = await clinicAt(20);
      const id = await patientIn(b, '2000-06-15');
      await put(b, 30, T);

      await expect(archive(b, id, IN_23H)).rejects.toMatchObject({
        response: {
          code: 'CLINICAL_RECORD_RETENTION',
          retentionUntil: '2030-06-15',
        },
      });
    });
  });

  it('the 24-hour boundary', async () => {
    const inside = await clinicAt(20);
    const atLimit = await clinicAt(20);
    await patientIn(inside, '2010-06-15');
    const id = await patientIn(atLimit, '2010-06-15');
    await put(inside, 30, T);
    await put(atLimit, 30, T);

    await put(inside, 20, after(24 * HOUR - 1));
    await put(atLimit, 20, after(24 * HOUR));

    expect(await floorsIn(inside)).toBe(0);
    expect(await floorOf(id)).toBe('2040-06-15');
  });

  it('chained raises keep the first window', async () => {
    const chain = async (): Promise<[string, string]> => {
      const b = await clinicAt(20);
      const id = await patientIn(b, '2010-06-15');
      await put(b, 25, T);
      await put(b, 30, after(23 * HOUR));
      return [b, id];
    };

    const [closing, closingPatient] = await chain();
    expect(await storedIn(closing)).toEqual({
      years: 30,
      raisedAt: T,
      yearsBeforeRaise: 20,
    });
    await put(closing, 20, after(24 * HOUR - 60 * 1000));
    expect(await floorOf(closingPatient)).toBeNull();

    const [late, latePatient] = await chain();
    await put(late, 20, after(24 * HOUR));
    expect(await floorOf(latePatient)).toBe('2040-06-15');

    const [reopened] = await chain();
    const later = after(25 * HOUR);
    await put(reopened, 35, later);
    expect(await storedIn(reopened)).toEqual({
      years: 35,
      raisedAt: later,
      yearsBeforeRaise: 30,
    });
  });

  it('audits one event per real change', async () => {
    const b = await clinicAt(20);
    await patientIn(b, '2010-06-15');

    await expect(put(b, 20, T)).resolves.toEqual({
      outcome: 'UNCHANGED',
      stored: { years: 20, raisedAt: null, yearsBeforeRaise: null },
    });
    await put(b, 15, T, false);
    expect(await eventsIn(b)).toEqual([]);

    await put(b, 30, T);
    await put(b, 30, T);
    await put(b, 15, after(25 * HOUR));

    const events = await eventsIn(b);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      action: 'UPDATE',
      resourceId: b,
      actorUserId: actorId,
      metadata: {
        reason: 'CLINICAL_RECORD_RETENTION_SETTINGS',
        changedFields: ['clinicalRecordRetentionYears'],
        configChange: {
          before: { clinicalRecordRetentionYears: 20 },
          after: { clinicalRecordRetentionYears: 30 },
        },
        retentionTermChange: {
          direction: 'UP',
          protectedPatients: 0,
          effectiveBefore: 20,
          effectiveAfter: 30,
          withinCorrectionWindow: false,
        },
      },
    });
    expect(events[1].metadata).toMatchObject({
      configChange: {
        before: { clinicalRecordRetentionYears: 30 },
        after: { clinicalRecordRetentionYears: 15 },
      },
      retentionTermChange: {
        direction: 'DOWN',
        protectedPatients: 1,
        effectiveBefore: 30,
        effectiveAfter: 15,
        withinCorrectionWindow: false,
      },
    });
  });

  it('SQL and TS agree on the floor date', async () => {
    const b = await clinicAt(25);
    const lasts = [
      '2024-02-29T00:00:00Z',
      '2024-02-29T23:59:00Z',
      '2023-12-31T23:59:00Z',
      '2000-02-29T10:00:00Z',
    ].map((at) => new Date(at));
    const extensions = ['NONE', 'DOUBLE', 'PERMANENT'] as const;
    const rows = lasts.flatMap((lastAttentionAt) =>
      extensions.map((retentionExtended) => ({
        id: randomUUID(),
        tenantId: b,
        firstName: 'Paridad',
        lastName: 'DX330',
        lastAttentionAt,
        retentionExtended,
      })),
    );
    await raw.patient.createMany({ data: rows });

    for (const years of [15, 20, 25]) {
      const dates = await prisma.runWithTenant(
        b,
        (tx) =>
          tx.$queryRaw<{ id: string; until: string }[]>`
          ${retentionCandidates(b, years, 15)}
          SELECT c.id, c.until::text AS until FROM c`,
      );
      const byId = new Map(dates.map((d) => [d.id, d.until]));
      expect(byId.size).toBe(rows.length);
      for (const row of rows) {
        expect(byId.get(row.id)).toBe(
          floorCandidate(row.lastAttentionAt, row.retentionExtended, years)
            .toISOString()
            .slice(0, 10),
        );
      }
    }
    // 2024-02-29 + 25 no existe: termina el 28, en la BD y en TS.
    expect(
      floorCandidate(lasts[0], 'NONE', 25).toISOString().slice(0, 10),
    ).toBe('2049-02-28');
  });

  it('maps lock and timeout errors to BUSY, and rethrows the rest', async () => {
    const known = (code: string, sqlState?: string) =>
      new Prisma.PrismaClientKnownRequestError('x', {
        code,
        clientVersion: 'test',
        meta: sqlState ? { code: sqlState } : undefined,
      });
    const failingWith = (error: Error) =>
      tenantContext.run('00000000-0000-0000-0000-000000000000', () =>
        new PrismaClinicRetentionSettingsRepository(
          { runWithTenant: () => Promise.reject(error) } as never,
          tenantContext,
          { platformMinYears: 15 },
        ).set(
          { clinicalRecordRetentionYears: 20, confirmReduction: true },
          ctxOf('00000000-0000-0000-0000-000000000000'),
          T,
        ),
      );

    for (const error of [
      known('P2010', '55P03'),
      known('P2010', '40P01'),
      known('P2034'),
      new Prisma.PrismaClientUnknownRequestError(
        'PostgresError { code: "40P01", message: "deadlock" }',
        { clientVersion: 'test' },
      ),
    ]) {
      await expect(failingWith(error)).resolves.toEqual({
        outcome: 'BUSY',
        reason: 'CONTENTION',
      });
    }
    await expect(failingWith(known('P2010', '57014'))).resolves.toEqual({
      outcome: 'BUSY',
      reason: 'TIMEOUT',
    });
    const other = known('P2010', '23514');
    await expect(failingWith(other)).rejects.toBe(other);
  });

  // R8 y PF1: el `set` real se detiene con el `FOR UPDATE` de una fila que su
  // `UPDATE` quiere escribir (PATTERNS X8), nunca con un bloqueo de `tenants`
  // de la prueba: así se ejercita el bloqueo que toma `set`.
  describe('concurrencia del cambio de plazo', () => {
    async function holdTransaction(
      work: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ): Promise<{ xid: string; release(): Promise<void> }> {
      const ready = gate<string>();
      const done = gate();
      const finished = settle(
        raw.$transaction(
          async (tx) => {
            await work(tx);
            ready.open(await transactionId(tx));
            await done.wait;
          },
          { timeout: 30_000 },
        ),
      );
      const failed = finished.then((outcome) => {
        if (outcome.status === 'rejected') {
          throw new Error(String(outcome.reason));
        }
        return '';
      });
      const xid = await Promise.race([ready.wait, failed]);
      return {
        xid,
        release: async () => {
          done.open();
          expect((await finished).status).toBe('fulfilled');
        },
      };
    }

    function holdPatientRow(patientId: string) {
      return holdTransaction(
        (tx) =>
          tx.$queryRaw`SELECT 1 FROM "patients" WHERE "id" = ${patientId}::uuid FOR UPDATE`,
      );
    }

    /** La transacción de quien espera a `xid`, para esperar a su vez detrás de ella. */
    async function waiterOf(xid: string): Promise<string> {
      const [row] = await raw.$queryRaw<{ xid: string }[]>`
        SELECT a."backend_xid"::text AS xid
          FROM pg_catalog.pg_locks l
          JOIN pg_catalog.pg_stat_activity a ON a."pid" = l."pid"
         WHERE l."locktype" = 'transactionid'
           AND l."transactionid"::text = ${xid}
           AND NOT l."granted"`;
      return row.xid;
    }

    /** Si la fila de la clínica estuviera tomada, esto da `55P03`, no una espera. */
    function withoutWaiting<T>(
      tenantId: string,
      insert: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> {
      return prisma.runWithTenant(tenantId, async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '200ms'`;
        return insert(tx);
      });
    }

    /** El segundo en la cola espera en el bloqueo de la fila, no en el xid. */
    async function waitForTupleWaiter(): Promise<void> {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const [row] = await raw.$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting FROM pg_catalog.pg_locks
           WHERE locktype = 'tuple' AND relation = '"tenants"'::regclass
             AND NOT granted`;
        if (row.waiting >= 1) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('el segundo cambio no llegó a la cola de la clínica');
    }

    it('archive waits for a raise and sees it', async () => {
      const started = Date.now();
      const a = await clinicAt(15);
      const id = await patientIn(a, '2010-06-15');
      const raise = await holdTransaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "tenants" WHERE "id" = ${a}::uuid FOR NO KEY UPDATE`;
        await tx.$executeRaw`UPDATE "tenants" SET "clinicalRecordRetentionYears" = 20 WHERE "id" = ${a}::uuid`;
      });
      try {
        const archiving = settle(archive(a, id));
        await waitForTransactionWaiters(raw, raise.xid);
        await raise.release();
        expect(await archiving).toMatchObject({
          status: 'rejected',
          reason: {
            response: {
              code: 'CLINICAL_RECORD_RETENTION',
              retentionUntil: '2030-06-15',
            },
          },
        });
      } finally {
        await raise.release();
      }
      const { deletedAt } = await raw.patient.findUniqueOrThrow({
        where: { id },
      });
      expect(deletedAt).toBeNull();
      expect(Date.now() - started).toBeLessThan(10_000);
    });

    it('a reduction and an archive do not deadlock', async () => {
      const started = Date.now();
      const b = await clinicAt(25);
      const id = await patientIn(b, '2010-06-15');
      const other = await patientIn(b, '2011-06-15');
      const held = await holdPatientRow(other);
      try {
        const reducing = settle(put(b, 15, T));
        await waitForTransactionWaiters(raw, held.xid);
        const archiving = settle(archive(b, id));
        await waitForTransactionWaiters(raw, await waiterOf(held.xid));
        await held.release();
        expect(await reducing).toMatchObject({
          status: 'fulfilled',
          value: { outcome: 'APPLIED', protectedPatients: 2 },
        });
        // Espera tras `tenants`, así que ve la reducción y el suelo que deja.
        expect(await archiving).toMatchObject({
          status: 'rejected',
          reason: {
            response: {
              code: 'CLINICAL_RECORD_RETENTION',
              retentionUntil: '2035-06-15',
            },
          },
        });
      } finally {
        await held.release();
      }
      expect(Date.now() - started).toBeLessThan(10_000);
    });

    it('the PUT does not block new records of the clinic', async () => {
      const b = await clinicAt(25);
      const pending = await patientIn(b, '2010-06-15');
      const unattended = await patientIn(b, null);
      const held = await holdPatientRow(pending);
      try {
        const reducing = settle(put(b, 15, T));
        await waitForTransactionWaiters(raw, held.xid);

        // `clinical_entries` no tiene FK a `tenants`, así que no ve este
        // bloqueo; `payers` y las demás tablas con esa FK, sí: su alta toma
        // KEY SHARE sobre la clínica y chocaría con un FOR UPDATE (M16).
        await withoutWaiting(b, (tx) =>
          tx.clinicalEntry.create({
            data: {
              tenantId: b,
              patientId: unattended,
              entryDate: T,
              notes: 'Control',
              performedById: actorId,
            },
          }),
        );
        await withoutWaiting(b, (tx) =>
          tx.payer.create({
            data: { tenantId: b, name: 'Alta', type: 'INSURER' },
          }),
        );
        await waitForTransactionWaiters(raw, held.xid);

        await held.release();
        expect(await reducing).toMatchObject({
          status: 'fulfilled',
          value: { outcome: 'APPLIED' },
        });
      } finally {
        await held.release();
      }
      expect(await floorOf(pending)).toBe('2035-06-15');
      // Su primera atención llegó con la reducción en curso: el trigger le fijó
      // la fecha de atención y la reducción no le escribió un suelo.
      const late = await raw.patient.findUniqueOrThrow({
        where: { id: unattended },
        select: { lastAttentionAt: true, retentionFloorUntil: true },
      });
      expect(late.lastAttentionAt).not.toBeNull();
      expect(late.retentionFloorUntil).toBeNull();
      // La reducción sí protegió al paciente que ya tenía atención.
      expect(await floorOf(pending)).toBe('2035-06-15');
    });

    it('a busy reduction writes nothing', async () => {
      const b = await clinicAt(25);
      // Ids en orden y fila detenida la última, en orden físico y de `id`: el
      // `UPDATE` llega a ella con las demás ya escritas.
      const ids = Array.from({ length: 12 }, () => randomUUID()).sort();
      await raw.patient.createMany({
        data: ids.map((id) => ({
          id,
          tenantId: b,
          firstName: 'Corte',
          lastName: 'DX330',
          lastAttentionAt: new Date('2010-06-15T10:00:00Z'),
        })),
      });
      const before = await storedIn(b);
      const held = await holdPatientRow(ids[ids.length - 1]);
      try {
        const reducing = settle(put(b, 15, T));
        await waitForTransactionWaiters(raw, held.xid);
        const free = await raw.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "patients" WHERE "tenantId" = ${b}::uuid
             FOR NO KEY UPDATE SKIP LOCKED`;
        expect(free.length).toBeLessThan(ids.length - 1);

        // La fila sigue detenida hasta que `lock_timeout` (5 s) corta el `set`.
        expect(await reducing).toEqual({
          status: 'fulfilled',
          value: { outcome: 'BUSY', reason: 'CONTENTION' },
        });
        expect(await storedIn(b)).toEqual(before);
        expect(await floorsIn(b)).toBe(0);
        expect(await eventsIn(b)).toHaveLength(0);
      } finally {
        await held.release();
      }
      await expect(put(b, 15, T)).resolves.toMatchObject({
        outcome: 'APPLIED',
        protectedPatients: ids.length,
      });
    }, 20_000);

    it('a failure after the floors rolls everything back', async () => {
      const b = await clinicAt(25);
      await patientIn(b, '2010-06-15');
      const before = await storedIn(b);
      // El evento es el último paso: `locationId` no es un uuid y el `INSERT`
      // falla con los suelos y el plazo ya escritos en la transacción.
      await expect(
        tenantContext.run(b, () =>
          settings.set(
            { clinicalRecordRetentionYears: 15, confirmReduction: true },
            { ...ctxOf(b), locationId: 'no-es-un-uuid' },
            T,
          ),
        ),
      ).rejects.toThrow();
      expect(await storedIn(b)).toEqual(before);
      expect(await floorsIn(b)).toBe(0);
      expect(await eventsIn(b)).toHaveLength(0);
    });

    it.each([
      {
        order: 'the raise and then the correction',
        first: 40,
        second: 20,
        end: { years: 20, raisedAt: null, yearsBeforeRaise: null },
        changes: ['20>30', '30>40', '40>20'],
      },
      {
        order: 'the correction and then the raise',
        first: 20,
        second: 40,
        end: { years: 40, raisedAt: after(23 * HOUR), yearsBeforeRaise: 20 },
        changes: ['20>30', '20>40', '30>20'],
      },
    ])(
      'a raise and a correction at once: $order',
      async ({ first, second, end, changes }) => {
        const b = await clinicAt(20);
        await patientIn(b, '2010-06-15');
        await put(b, 30, T);
        const at = after(23 * HOUR);

        // La cola de la fila de la clínica fija el orden: el primero espera
        // al xid del holder y el segundo, en el bloqueo de la fila.
        const clinic = await holdTransaction(
          (tx) =>
            tx.$queryRaw`SELECT 1 FROM "tenants" WHERE "id" = ${b}::uuid FOR NO KEY UPDATE`,
        );
        try {
          const firstPut = settle(put(b, first, at));
          await waitForTransactionWaiters(raw, clinic.xid);
          const secondPut = settle(put(b, second, at));
          await waitForTupleWaiter();
          await clinic.release();

          for (const result of [await firstPut, await secondPut]) {
            expect(result).toMatchObject({
              status: 'fulfilled',
              value: { outcome: 'APPLIED' },
            });
          }
        } finally {
          await clinic.release();
        }

        expect(await storedIn(b)).toEqual(end);
        expect(await floorsIn(b)).toBe(0);
        const seen = (await eventsIn(b))
          .map((event) => {
            const { configChange } = event.metadata as unknown as {
              configChange: Record<
                'before' | 'after',
                { clinicalRecordRetentionYears: number }
              >;
            };
            return `${configChange.before.clinicalRecordRetentionYears}>${configChange.after.clinicalRecordRetentionYears}`;
          })
          .sort();
        expect(seen).toEqual(changes);
      },
    );
  });
});
