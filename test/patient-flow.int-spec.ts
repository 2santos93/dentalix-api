import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AppointmentStatus,
  ClinicRole,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaAppointmentRepository } from '../src/modules/appointments/infrastructure/repositories/prisma-appointment.repository';
import { PrismaLocationRepository } from '../src/modules/locations/infrastructure/repositories/prisma-location.repository';
import { ListInClinicUseCase } from '../src/modules/appointments/application/use-cases/list-in-clinic.use-case';
import { overlapExclusionScope } from '../src/modules/appointments/application/appointment-overlap-error';

// DX-200, capa DB del flujo del paciente en la clínica:
//  1. las migraciones sobre una BD con citas en todos los estados de antes:
//     nada cambia, las columnas nuevas quedan en null, el enum crece sin
//     renombrar y la CHECK de horas ya rige (también en las filas viejas);
//  2. el panel «En clínica» y «Deshacer llegada» por la MISMA ruta que la app
//     (runWithTenant, rol dentalix_app, RLS): aislado por clínica y por sede.

const ROOT = join(__dirname, '..');
const FIRST = '20261019195000_dx200_appointment_flow_statuses';
const DX200 = [
  FIRST,
  '20261019195010_dx200_appointment_flow_times',
  '20261019195020_dx200_appointments_in_clinic_idx',
];

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

function urlFor(db: string): string {
  const url = new URL(process.env.DIRECT_URL as string);
  url.pathname = `/${db}`;
  return url.toString();
}

function migrateDeploy(dir: string, url: string): void {
  execFileSync(
    join(ROOT, 'node_modules/.bin/prisma'),
    ['migrate', 'deploy', '--schema', join(dir, 'schema.prisma')],
    {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
      stdio: 'pipe',
    },
  );
}

describe('DX-200 · migración del flujo en la clínica sobre datos existentes (int)', () => {
  const db = `dx200_mig_${process.pid}_${Date.now()}`;
  let dir: string;
  let target: PrismaClient;
  const T = '00000000-0000-4000-8000-00000000a200';
  const L = '00000000-0000-4000-8000-00000000b200';
  const P = '00000000-0000-4000-8000-00000000c200';

  beforeAll(async () => {
    await raw.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    dir = mkdtempSync(join(tmpdir(), 'dx200-'));
    cpSync(join(ROOT, 'prisma/schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(
      join(ROOT, 'prisma/migrations/migration_lock.toml'),
      join(dir, 'migrations/migration_lock.toml'),
    );
    for (const name of readdirSync(join(ROOT, 'prisma/migrations'))) {
      if (name < FIRST && !name.endsWith('.toml')) {
        cpSync(
          join(ROOT, 'prisma/migrations', name),
          join(dir, 'migrations', name),
          { recursive: true },
        );
      }
    }
    migrateDeploy(dir, urlFor(db));
    target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: urlFor(db) } },
    });
    await target.$executeRawUnsafe(
      `INSERT INTO "tenants" ("id","name","subdomain","updatedAt") VALUES ('${T}','Clínica','dx200-mig',now())`,
    );
    await target.$executeRawUnsafe(
      `INSERT INTO "locations" ("id","tenantId","name","updatedAt") VALUES ('${L}','${T}','Sede',now())`,
    );
    await target.$executeRawUnsafe(
      `INSERT INTO "patients" ("id","tenantId","firstName","lastName","updatedAt") VALUES ('${P}','${T}','Ana','Antigua',now())`,
    );
    // Una cita por estado de los de siempre, en días distintos (sin solapes).
    const statuses = [
      'SCHEDULED',
      'CONFIRMED',
      'COMPLETED',
      'CANCELLED',
      'NO_SHOW',
    ];
    for (const [i, status] of statuses.entries()) {
      await target.$executeRawUnsafe(
        `INSERT INTO "appointments" ("id","tenantId","locationId","patientId","providerId","start","end","status","updatedAt")
         VALUES (gen_random_uuid(),'${T}','${L}','${P}',gen_random_uuid(),
                 timestamp '2026-09-0${i + 1} 14:00', timestamp '2026-09-0${i + 1} 14:30','${status}',now())`,
      );
    }
  }, 240_000);

  afterAll(async () => {
    await target?.$disconnect();
    await raw.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    rmSync(dir, { recursive: true, force: true });
  });

  it('las citas antiguas no cambian, quedan sin horas y la restricción ya rige', async () => {
    const before = await target.$queryRaw<{ status: string; start: Date }[]>`
      SELECT "status"::text, "start" FROM "appointments" ORDER BY "start"`;

    for (const name of DX200) {
      cpSync(
        join(ROOT, 'prisma/migrations', name),
        join(dir, 'migrations', name),
        {
          recursive: true,
        },
      );
    }
    migrateDeploy(dir, urlFor(db));

    const after = await target.$queryRaw<
      {
        status: string;
        start: Date;
        arrivedAt: Date | null;
        seatedAt: Date | null;
        readyForCheckoutAt: Date | null;
        preArrivalStatus: string | null;
      }[]
    >`SELECT "status"::text, "start", "arrivedAt", "seatedAt", "readyForCheckoutAt",
             "preArrivalStatus"::text
        FROM "appointments" ORDER BY "start"`;
    expect(after.map(({ status, start }) => ({ status, start }))).toEqual(
      before,
    );
    for (const row of after) {
      expect([
        row.arrivedAt,
        row.seatedAt,
        row.readyForCheckoutAt,
        row.preArrivalStatus,
      ]).toEqual([null, null, null, null]);
    }

    // El enum crece al final, sin renombrar ni reordenar lo que había.
    const labels = await target.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'AppointmentStatus' ORDER BY e.enumsortorder`;
    expect(labels.map((l) => l.label)).toEqual([
      'SCHEDULED',
      'CONFIRMED',
      'COMPLETED',
      'CANCELLED',
      'NO_SHOW',
      'ARRIVED',
      'IN_CHAIR',
      'READY_FOR_CHECKOUT',
    ]);

    const [check] = await target.$queryRaw<{ validated: boolean }[]>`
      SELECT convalidated AS validated FROM pg_constraint
       WHERE conname = 'appointments_flow_times_check'`;
    expect(check.validated).toBe(true);

    const [index] = await target.$queryRaw<{ valid: boolean; def: string }[]>`
      SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = 'appointments_tenant_location_in_clinic_idx'`;
    expect(index.valid).toBe(true);
    expect(index.def).toMatch(/WHERE/);

    // Un estado del flujo sin su hora no entra; con ella, sí. Una cita vieja
    // se completa como siempre.
    await expect(
      target.$executeRawUnsafe(
        `UPDATE "appointments" SET "status" = 'ARRIVED' WHERE "status" = 'SCHEDULED'`,
      ),
    ).rejects.toThrow(/appointments_flow_times_check/);
    await expect(
      target.$executeRawUnsafe(
        `UPDATE "appointments" SET "status" = 'IN_CHAIR', "arrivedAt" = now() WHERE "status" = 'SCHEDULED'`,
      ),
    ).rejects.toThrow(/appointments_flow_times_check/);
    await target.$executeRawUnsafe(
      `UPDATE "appointments" SET "status" = 'ARRIVED', "arrivedAt" = now(), "preArrivalStatus" = 'SCHEDULED' WHERE "status" = 'SCHEDULED'`,
    );
    await target.$executeRawUnsafe(
      `UPDATE "appointments" SET "status" = 'COMPLETED' WHERE "status" = 'CONFIRMED'`,
    );
  });
});

describe('DX-200 · panel «En clínica» y «Deshacer llegada» con RLS (int)', () => {
  const tenantContext = new TenantContextService();
  const prisma = new PrismaService(tenantContext);
  const repo = new PrismaAppointmentRepository(prisma, tenantContext);
  const panel = new ListInClinicUseCase(
    repo,
    new PrismaLocationRepository(prisma, tenantContext),
    tenantContext,
  );
  const SUBDOMAINS = ['dx200-int-a', 'dx200-int-b'];
  // Mediodía de Bogotá de un día fijo: las horas no dependen de la corrida.
  const DAY = '2026-11-03';
  const NOON = new Date(`${DAY}T17:00:00.000Z`);
  const DOCTOR = randomUUID();
  const OTHER_DOCTOR = randomUUID();

  interface Clinic {
    tenantId: string;
    main: string;
    north: string;
    patientId: string;
  }
  let a: Clinic;
  let b: Clinic;

  async function seedClinic(subdomain: string): Promise<Clinic> {
    const tenant = await raw.tenant.create({
      data: { name: subdomain, subdomain },
    });
    const main = await raw.location.create({
      data: { tenantId: tenant.id, name: 'Principal', country: 'CO' },
    });
    const north = await raw.location.create({
      data: { tenantId: tenant.id, name: 'Norte', country: 'CO' },
    });
    const patient = await raw.patient.create({
      data: { tenantId: tenant.id, firstName: 'Paz', lastName: subdomain },
    });
    return {
      tenantId: tenant.id,
      main: main.id,
      north: north.id,
      patientId: patient.id,
    };
  }

  async function arrived(
    c: Clinic,
    locationId: string,
    hhmm: string,
    providerId = DOCTOR,
  ) {
    const start = new Date(`${DAY}T${hhmm}:00.000-05:00`);
    return raw.appointment.create({
      data: {
        tenantId: c.tenantId,
        locationId,
        patientId: c.patientId,
        providerId,
        start,
        end: new Date(start.getTime() + 20 * 60_000),
        status: AppointmentStatus.ARRIVED,
        preArrivalStatus: AppointmentStatus.CONFIRMED,
        arrivedAt: new Date(start.getTime() - 5 * 60_000),
        reason: 'Dato clínico que el panel no muestra',
      },
    });
  }

  async function cleanup() {
    const tenants = await raw.tenant.findMany({
      where: { subdomain: { in: SUBDOMAINS } },
      select: { id: true },
    });
    const where = { tenantId: { in: tenants.map((t) => t.id) } };
    await raw.appointment.deleteMany({ where });
    await raw.patient.deleteMany({ where });
    await raw.locationSchedule.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.tenant.deleteMany({ where: { id: where.tenantId } });
  }

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('cada sede ve solo lo suyo; otra clínica no ve nada (ni con el id de la sede)', async () => {
    // Patient-level EXCLUDE: un paciente, una cita a la vez; horas distintas.
    const inMain = await arrived(a, a.main, '11:00');
    const inNorth = await arrived(a, a.north, '11:30');
    const inB = await arrived(b, b.main, '11:00');

    const viewMain = await tenantContext.run(a.tenantId, a.main, () =>
      panel.execute(
        { locationId: a.main, role: ClinicRole.RECEPTION, userId: 'x' },
        NOON,
      ),
    );
    expect(viewMain.waiting.map((i) => i.appointmentId)).toEqual([inMain.id]);
    expect(viewMain.waiting[0]).not.toHaveProperty('reason');
    expect(viewMain.waiting[0]).toMatchObject({
      punctuality: 'ON_TIME',
      minutesInStatus: 65,
    });

    const viewNorth = await tenantContext.run(a.tenantId, a.north, () =>
      panel.execute(
        { locationId: a.north, role: ClinicRole.ADMIN, userId: 'x' },
        NOON,
      ),
    );
    expect(viewNorth.waiting.map((i) => i.appointmentId)).toEqual([inNorth.id]);

    // B pidiendo con el id de la sede de A: la RLS no deja ver ni la sede.
    await expect(
      tenantContext.run(b.tenantId, undefined, () =>
        panel.execute(
          { locationId: a.main, role: ClinicRole.ADMIN, userId: 'x' },
          NOON,
        ),
      ),
    ).rejects.toThrow(/Sede no encontrada/);
    // Y el repositorio, aun con la sede de A, no devuelve filas de A.
    const leaked = await tenantContext.run(b.tenantId, undefined, () =>
      repo.listInClinic({
        locationId: a.main,
        from: new Date(`${DAY}T05:00:00.000Z`),
        to: new Date(`${DAY}T23:59:00.000Z`),
      }),
    );
    expect(leaked).toEqual([]);
    const own = await tenantContext.run(b.tenantId, undefined, () =>
      repo.listInClinic({
        locationId: b.main,
        from: new Date(`${DAY}T05:00:00.000Z`),
        to: new Date(`${DAY}T23:59:00.000Z`),
      }),
    );
    expect(own.map((r) => r.id)).toEqual([inB.id]);
  });

  it('DENTIST: solo sus pacientes', async () => {
    const other = await arrived(a, a.main, '12:00', OTHER_DOCTOR);
    const view = await tenantContext.run(a.tenantId, a.main, () =>
      panel.execute(
        { locationId: a.main, role: ClinicRole.DENTIST, userId: OTHER_DOCTOR },
        NOON,
      ),
    );
    expect(view.waiting.map((i) => i.appointmentId)).toEqual([other.id]);
  });

  it('«Deshacer llegada» vuelve al estado previo y borra la hora; otra clínica no puede', async () => {
    const appt = await arrived(a, a.main, '13:00');
    const fromB = await tenantContext.run(b.tenantId, undefined, () =>
      repo.undoArrival(appt.id),
    );
    expect(fromB).toBeNull();
    expect(
      (await raw.appointment.findUniqueOrThrow({ where: { id: appt.id } }))
        .status,
    ).toBe(AppointmentStatus.ARRIVED);

    const undone = await tenantContext.run(a.tenantId, a.main, () =>
      repo.undoArrival(appt.id),
    );
    expect(undone).toMatchObject({
      status: AppointmentStatus.CONFIRMED,
      arrivedAt: null,
    });
    const row = await raw.appointment.findUniqueOrThrow({
      where: { id: appt.id },
    });
    expect(row.preArrivalStatus).toBeNull();
    // Una segunda vez ya no está en espera.
    expect(
      await tenantContext.run(a.tenantId, a.main, () =>
        repo.undoArrival(appt.id),
      ),
    ).toBeNull();
  });

  it('el paso del flujo es condicional al estado leído (dos a la vez: uno gana, 409 el otro)', async () => {
    const appt = await arrived(a, a.main, '14:00');
    const seat = () =>
      tenantContext.run(a.tenantId, a.main, () =>
        repo.update(appt.id, {
          status: AppointmentStatus.IN_CHAIR,
          seatedAt: new Date(`${DAY}T19:05:00.000Z`),
          preArrivalStatus: null,
          expectStatus: AppointmentStatus.ARRIVED,
        }),
      );
    const results = await Promise.allSettled([seat(), seat()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(String(rejected?.reason)).toMatch(/cambió mientras tanto/);
  });
  it('un no-show a la vez que «Llegó»: gana uno y el otro es 409 (no un 500 de la CHECK)', async () => {
    const start = new Date(`${DAY}T15:00:00.000-05:00`);
    const appt = await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId: a.main,
        patientId: a.patientId,
        providerId: DOCTOR,
        start,
        end: new Date(start.getTime() + 20 * 60_000),
        status: AppointmentStatus.SCHEDULED,
      },
    });
    const arrive = () =>
      tenantContext.run(a.tenantId, a.main, () =>
        repo.update(appt.id, {
          status: AppointmentStatus.ARRIVED,
          arrivedAt: start,
          preArrivalStatus: AppointmentStatus.SCHEDULED,
          expectStatus: AppointmentStatus.SCHEDULED,
        }),
      );
    const noShow = () =>
      tenantContext.run(a.tenantId, a.main, () =>
        repo.update(appt.id, {
          status: AppointmentStatus.NO_SHOW,
          expectStatus: AppointmentStatus.SCHEDULED,
        }),
      );
    const results = await Promise.allSettled([arrive(), noShow()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(String(rejected?.reason)).toMatch(/cambió mientras tanto/);
  });

  it('reactivar una cita cancelada en un hueco ya ocupado sigue siendo un solape (23P01 → 409)', async () => {
    const start = new Date(`${DAY}T16:00:00.000-05:00`);
    const base = {
      tenantId: a.tenantId,
      locationId: a.main,
      patientId: a.patientId,
      providerId: OTHER_DOCTOR,
      start,
      end: new Date(start.getTime() + 20 * 60_000),
    };
    const cancelled = await raw.appointment.create({
      data: { ...base, status: AppointmentStatus.CANCELLED },
    });
    await raw.appointment.create({
      data: { ...base, status: AppointmentStatus.SCHEDULED },
    });
    const error = await tenantContext
      .run(a.tenantId, a.main, () =>
        repo.update(cancelled.id, {
          status: AppointmentStatus.SCHEDULED,
          expectStatus: AppointmentStatus.CANCELLED,
        }),
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(overlapExclusionScope(error)).not.toBeNull();
  });
});
