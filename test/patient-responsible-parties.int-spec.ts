import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

// DX-203, capa DB: responsables de pago y avisos (patient_responsible_parties).
// RLS FORCE, FK COMPUESTAS (vincular entre clínicas falla), las CHECK de forma
// y los índices únicos parciales (un pagador principal, el mismo paciente una
// vez), y la copia de guardian* idempotente. Lo que se prueba va por la MISMA
// ruta que la app (runWithTenant, rol dentalix_app, sujeto a RLS); `raw`
// (DIRECT_URL, superusuario) siembra y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAINS = ['dx203-int-a', 'dx203-int-b'];
const BACKFILL = readFileSync(
  join(
    __dirname,
    '../prisma/migrations/20261018150100_dx203_guardian_to_responsible/migration.sql',
  ),
  'utf8',
);

interface Clinic {
  tenantId: string;
  patients: string[];
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const patients: string[] = [];
  for (const firstName of ['Madre', 'Hijo', 'Hija']) {
    const patient = await raw.patient.create({
      data: { tenantId: tenant.id, firstName, lastName: subdomain },
    });
    patients.push(patient.id);
  }
  return { tenantId: tenant.id, patients };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length === 0) return;
  const where = { tenantId: { in: ids } };
  await raw.patientResponsibleParty.deleteMany({ where });
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

describe('responsables de pago y avisos (int, DX-203)', () => {
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

  afterEach(async () => {
    await raw.patientResponsibleParty.deleteMany({
      where: { tenantId: { in: [a.tenantId, b.tenantId] } },
    });
  });

  function asA<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(a.tenantId, fn);
  }

  const contact = (
    clinic: Clinic,
    patientId: string,
    extra: Partial<Prisma.PatientResponsiblePartyUncheckedCreateInput> = {},
  ): Prisma.PatientResponsiblePartyUncheckedCreateInput => ({
    tenantId: clinic.tenantId,
    patientId,
    fullName: 'Claudia Navarro',
    relationship: 'MOTHER',
    ...extra,
  });

  it('RLS FORCE: la tabla tiene RLS forzada y otra clínica no ve las filas', async () => {
    const [row] = await raw.$queryRaw<{ rls: boolean; force: boolean }[]>`
      SELECT relrowsecurity AS rls, relforcerowsecurity AS force
        FROM pg_class WHERE relname = 'patient_responsible_parties'`;
    expect(row).toEqual({ rls: true, force: true });

    await asA((tx) =>
      tx.patientResponsibleParty.create({ data: contact(a, a.patients[1]) }),
    );
    const fromB = await prisma.runWithTenant(b.tenantId, (tx) =>
      tx.patientResponsibleParty.count(),
    );
    expect(fromB).toBe(0);
    expect(await asA((tx) => tx.patientResponsibleParty.count())).toBe(1);
  });

  it('RLS: escribir con el tenantId de otra clínica falla (WITH CHECK)', async () => {
    await expect(
      asA((tx) =>
        tx.patientResponsibleParty.create({
          data: contact(b, b.patients[1]),
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('FK compuesta: el responsable no puede ser un paciente de otra clínica', async () => {
    await expect(
      asA((tx) =>
        tx.patientResponsibleParty.create({
          data: {
            tenantId: a.tenantId,
            patientId: a.patients[1],
            responsiblePatientId: b.patients[0],
            relationship: 'MOTHER',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2003' });
    // Ni como superusuario (las FK no se saltan la clínica).
    await expect(
      raw.patientResponsibleParty.create({
        data: {
          tenantId: a.tenantId,
          patientId: a.patients[1],
          responsiblePatientId: b.patients[0],
          relationship: 'MOTHER',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('FK compuesta: el paciente tampoco puede ser de otra clínica', async () => {
    await expect(
      raw.patientResponsibleParty.create({
        data: contact(a, b.patients[1]),
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('CHECK: un paciente responsable no lleva datos de contacto propios; un contacto, nombre', async () => {
    await expect(
      asA((tx) =>
        tx.patientResponsibleParty.create({
          data: contact(a, a.patients[1], {
            responsiblePatientId: a.patients[0],
          }),
        }),
      ),
    ).rejects.toThrow(/patient_responsible_parties_kind_check/);
    await expect(
      asA((tx) =>
        tx.patientResponsibleParty.create({
          data: contact(a, a.patients[1], { fullName: '   ' }),
        }),
      ),
    ).rejects.toThrow(/patient_responsible_parties_kind_check/);
    await expect(
      asA((tx) =>
        tx.patientResponsibleParty.create({
          data: {
            tenantId: a.tenantId,
            patientId: a.patients[0],
            responsiblePatientId: a.patients[0],
            relationship: 'OTHER',
          },
        }),
      ),
    ).rejects.toThrow(/patient_responsible_parties_not_self_check/);
  });

  it('un solo pagador principal vivo por paciente; quitado, se puede nombrar otro', async () => {
    const first = await asA((tx) =>
      tx.patientResponsibleParty.create({
        data: contact(a, a.patients[1], { isPayer: true }),
      }),
    );
    await expect(
      asA((tx) =>
        tx.patientResponsibleParty.create({
          data: {
            tenantId: a.tenantId,
            patientId: a.patients[1],
            responsiblePatientId: a.patients[0],
            relationship: 'FATHER',
            isPayer: true,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
    await asA((tx) =>
      tx.patientResponsibleParty.update({
        where: { id: first.id },
        data: { deletedAt: new Date() },
      }),
    );
    await expect(
      asA((tx) =>
        tx.patientResponsibleParty.create({
          data: {
            tenantId: a.tenantId,
            patientId: a.patients[1],
            responsiblePatientId: a.patients[0],
            relationship: 'FATHER',
            isPayer: true,
          },
        }),
      ),
    ).resolves.toMatchObject({ isPayer: true });
  });

  it('el mismo paciente responsable, una sola vez por paciente', async () => {
    const link = {
      tenantId: a.tenantId,
      patientId: a.patients[1],
      responsiblePatientId: a.patients[0],
      relationship: 'MOTHER' as const,
    };
    await asA((tx) => tx.patientResponsibleParty.create({ data: link }));
    await expect(
      asA((tx) => tx.patientResponsibleParty.create({ data: link })),
    ).rejects.toMatchObject({ code: 'P2002' });
    // Para OTRO hijo sí (una madre responsable de dos).
    await expect(
      asA((tx) =>
        tx.patientResponsibleParty.create({
          data: { ...link, patientId: a.patients[2] },
        }),
      ),
    ).resolves.toMatchObject({ patientId: a.patients[2] });
  });

  it('migración de guardian*: copia cada acudiente con valor una sola vez y no toca los campos antiguos', async () => {
    await raw.patient.update({
      where: { id: a.patients[1] },
      data: {
        guardianName: '  Claudia Navarro ',
        guardianDocNumber: '52987654',
      },
    });
    await raw.patient.update({
      where: { id: a.patients[2] },
      data: { guardianName: '   ', guardianDocNumber: '7933' },
    });
    await raw.patient.update({
      where: { id: b.patients[1] },
      data: { guardianName: 'Óscar Cifuentes', deletedAt: new Date() },
    });

    await runBackfill();
    const read = () =>
      raw.patientResponsibleParty.findMany({
        where: { tenantId: { in: [a.tenantId, b.tenantId] } },
        orderBy: { fullName: 'asc' },
        select: {
          tenantId: true,
          patientId: true,
          fullName: true,
          docNumber: true,
          relationship: true,
          isPayer: true,
          receivesNotices: true,
          migratedFromGuardian: true,
        },
      });
    const first = await read();
    expect(first).toEqual([
      {
        tenantId: a.tenantId,
        patientId: a.patients[2],
        fullName: 'Acudiente',
        docNumber: '7933',
        relationship: 'LEGAL_GUARDIAN',
        isPayer: false,
        receivesNotices: true,
        migratedFromGuardian: true,
      },
      {
        tenantId: a.tenantId,
        patientId: a.patients[1],
        fullName: 'Claudia Navarro',
        docNumber: '52987654',
        relationship: 'LEGAL_GUARDIAN',
        isPayer: false,
        receivesNotices: true,
        migratedFromGuardian: true,
      },
      {
        tenantId: b.tenantId,
        patientId: b.patients[1],
        fullName: 'Óscar Cifuentes',
        docNumber: null,
        relationship: 'LEGAL_GUARDIAN',
        isPayer: false,
        receivesNotices: true,
        migratedFromGuardian: true,
      },
    ]);

    // Idempotente: ni otra pasada ni quitar el contacto en la ficha crean otro.
    await raw.patientResponsibleParty.updateMany({
      where: { patientId: a.patients[1] },
      data: { deletedAt: new Date() },
    });
    await runBackfill();
    expect((await read()).length).toBe(3);

    // Los campos antiguos quedan como estaban (solo lectura).
    const old = await raw.patient.findUniqueOrThrow({
      where: { id: a.patients[1] },
      select: { guardianName: true, guardianDocNumber: true },
    });
    expect(old).toEqual({
      guardianName: '  Claudia Navarro ',
      guardianDocNumber: '52987654',
    });
    // Y FORCE sigue puesto en las dos tablas tras la copia.
    const force = await raw.$queryRaw<{ relname: string; force: boolean }[]>`
      SELECT relname, relforcerowsecurity AS force FROM pg_class
       WHERE relname IN ('patients', 'patient_responsible_parties')
       ORDER BY relname`;
    expect(force).toEqual([
      { relname: 'patient_responsible_parties', force: true },
      { relname: 'patients', force: true },
    ]);
  });
});
