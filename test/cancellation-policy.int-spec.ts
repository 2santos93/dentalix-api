import { Prisma, PrismaClient } from '@prisma/client';
import { resetDatabase } from './support/e2e-fixtures';

// DX-279, capa DB: política de cancelación por sede (versiones INALTERABLES),
// columnas de cancelación/inasistencia de la cita con su CHECK de coherencia,
// RLS FORCE y FK compuestas por tenant. Las escrituras de la app van como
// dentalix_app (DATABASE_URL, sujeto a RLS) con `app.current_tenant`; `raw`
// (DIRECT_URL, superusuario) siembra, mira el catálogo y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

/** SQL como dentalix_app con `app.current_tenant` fijado (como la app). */
function asApp<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return appRole.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}

/** Lo mismo como owner (superusuario), sujeto al trigger pero no a los grants. */
function asOwner<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return raw.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}

interface Seeded {
  tenantId: string;
  locationId: string;
  patientId: string;
  appointmentId: string;
  policyId: string;
}

let userId: string;

async function insertPolicy(
  tx: Prisma.TransactionClient,
  s: { tenantId: string; locationId: string },
  version: number,
): Promise<string> {
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "cancellation_policy_versions"
       ("id", "tenantId", "locationId", "version", "noticeHours",
        "suggestedFee", "currency", "patientText", "createdById")
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, 24, 50000, 'COP',
             'Avísanos con 24 horas.', $4::uuid)
     RETURNING "id"`,
    s.tenantId,
    s.locationId,
    version,
    userId,
  );
  return rows[0].id;
}

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const location = await raw.location.create({
    data: { tenantId, name: `Sede ${subdomain}` },
  });
  const patient = await raw.patient.create({
    data: { tenantId, firstName: 'Ana', lastName: subdomain },
  });
  const appointment = await raw.appointment.create({
    data: {
      tenantId,
      locationId: location.id,
      patientId: patient.id,
      providerId: userId,
      start: new Date(Date.UTC(2026, 10, 20, 14, 0)),
      end: new Date(Date.UTC(2026, 10, 20, 14, 30)),
    },
  });
  const policyId = await asApp(tenantId, (tx) =>
    insertPolicy(tx, { tenantId, locationId: location.id }, 1),
  );
  return {
    tenantId,
    locationId: location.id,
    patientId: patient.id,
    appointmentId: appointment.id,
    policyId,
  };
}

async function expectSqlError(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  await expect(promise).rejects.toThrow(pattern);
}

describe('política de cancelación y cancelación de la cita (DX-279, int)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    await resetDatabase(raw);
    userId = (
      await raw.user.create({
        data: {
          email: 'dx279-int@example.com',
          passwordHash: 'x',
          fullName: 'Dra. Admin',
        },
      })
    ).id;
    a = await seedClinic('dx279-int-a');
    b = await seedClinic('dx279-int-b');
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await appRole.$disconnect();
  });

  describe('inmutabilidad de cancellation_policy_versions', () => {
    it('la app no puede hacer UPDATE ni DELETE (sin privilegio)', async () => {
      await expectSqlError(
        asApp(a.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE "cancellation_policy_versions" SET "noticeHours" = 1 WHERE "id" = $1::uuid`,
            a.policyId,
          ),
        ),
        /permission denied/,
      );
      await expectSqlError(
        asApp(a.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `DELETE FROM "cancellation_policy_versions" WHERE "id" = $1::uuid`,
            a.policyId,
          ),
        ),
        /permission denied/,
      );
    });

    it('el trigger lo rechaza también al owner con la clínica fijada', async () => {
      await expectSqlError(
        asOwner(a.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE "cancellation_policy_versions" SET "patientText" = 'otro' WHERE "id" = $1::uuid`,
            a.policyId,
          ),
        ),
        /inalterable/,
      );
      const after = await raw.cancellationPolicyVersion.findUniqueOrThrow({
        where: { id: a.policyId },
      });
      expect(after).toMatchObject({
        noticeHours: 24,
        patientText: 'Avísanos con 24 horas.',
      });
    });

    it('la versión siguiente se inserta sin tocar la anterior; el número no se repite', async () => {
      await asApp(a.tenantId, (tx) => insertPolicy(tx, a, 2));
      await expect(
        asApp(a.tenantId, (tx) => insertPolicy(tx, a, 2)),
      ).rejects.toThrow(
        /cancellation_policy_versions_location_version_key|Unique constraint/,
      );
      const versions = await raw.cancellationPolicyVersion.findMany({
        where: { locationId: a.locationId },
        orderBy: { version: 'asc' },
      });
      expect(versions.map((v) => v.version)).toEqual([1, 2]);
    });

    it.each([
      ['horas fuera de 0–168', `"noticeHours" = 169`],
      ['importe negativo', `"suggestedFee" = -1`],
      ['importe sin moneda', `"currency" = NULL`],
      ['texto de más de 1000', `"patientText" = repeat('a', 1001)`],
    ])('CHECK de la política: %s', async (_label, override) => {
      const values: Record<string, string> = {
        noticeHours: '24',
        suggestedFee: '100',
        currency: `'COP'`,
        patientText: `''`,
      };
      const [col, val] = override.split(' = ');
      values[col.replace(/"/g, '')] = val;
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO "cancellation_policy_versions"
               ("id", "tenantId", "locationId", "version", "noticeHours",
                "suggestedFee", "currency", "patientText", "createdById")
             VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 99, ${values.noticeHours},
                     ${values.suggestedFee}, ${values.currency}, ${values.patientText}, $3::uuid)`,
            a.tenantId,
            a.locationId,
            userId,
          ),
        ),
      ).rejects.toThrow(/check constraint|value too long/);
    });
  });

  describe('RLS FORCE y FK compuestas', () => {
    it('la tabla tiene RLS activada y forzada', async () => {
      const [row] = await raw.$queryRaw<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
         WHERE relname = 'cancellation_policy_versions'`;
      expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it('B no ve la política de A ni puede escribir en su nombre', async () => {
      const seen = await asApp(b.tenantId, (tx) =>
        tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT "id" FROM "cancellation_policy_versions" WHERE "tenantId" = $1::uuid`,
          a.tenantId,
        ),
      );
      expect(seen).toEqual([]);
      await expect(
        asApp(b.tenantId, (tx) =>
          insertPolicy(
            tx,
            { tenantId: a.tenantId, locationId: a.locationId },
            7,
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('la política no admite la sede de otra clínica', async () => {
      await expect(
        asApp(b.tenantId, (tx) =>
          insertPolicy(
            tx,
            { tenantId: b.tenantId, locationId: a.locationId },
            7,
          ),
        ),
      ).rejects.toThrow(
        /cancellation_policy_versions_location_fkey|foreign key/,
      );
    });

    it('la cita no admite la versión de política de otra clínica', async () => {
      await expect(
        asApp(b.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE "appointments" SET "policyVersionId" = $1::uuid WHERE "id" = $2::uuid`,
            a.policyId,
            b.appointmentId,
          ),
        ),
      ).rejects.toThrow(/appointments_policy_version_fkey|foreign key/);
      await asApp(b.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "appointments" SET "policyVersionId" = $1::uuid WHERE "id" = $2::uuid`,
          b.policyId,
          b.appointmentId,
        ),
      );
      await asApp(b.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "appointments" SET "policyVersionId" = NULL WHERE "id" = $1::uuid`,
          b.appointmentId,
        ),
      );
    });
  });

  describe('CHECK appointments_cancellation_check', () => {
    const update = (s: Seeded, set: string) =>
      asApp(s.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "appointments" SET ${set} WHERE "id" = $1::uuid`,
          s.appointmentId,
        ),
      );

    afterEach(async () => {
      await update(
        a,
        `"status" = 'SCHEDULED', "cancelledAt" = NULL, "cancelledByKind" = NULL,
         "cancelReasonCode" = NULL, "cancelReasonText" = NULL, "noticeMinutes" = NULL,
         "lateCancellation" = NULL, "noShowMarkedAt" = NULL`,
      );
    });

    it('una cancelada antigua, sin ningún dato, sigue siendo válida (y una no-show antigua)', async () => {
      await update(a, `"status" = 'CANCELLED'`);
      await update(a, `"status" = 'NO_SHOW'`);
    });

    it('una cancelación completa del personal es válida', async () => {
      await update(
        a,
        `"status" = 'CANCELLED', "cancelledAt" = now(), "cancelledByKind" = 'STAFF_FOR_PATIENT',
         "cancelReasonCode" = 'ILLNESS', "cancelReasonText" = 'Gripe', "noticeMinutes" = 300,
         "lateCancellation" = true`,
      );
    });

    it('el enlace del paciente puede no traer motivo', async () => {
      await update(
        a,
        `"status" = 'CANCELLED', "cancelledAt" = now(), "cancelledByKind" = 'PATIENT_LINK',
         "noticeMinutes" = 300, "lateCancellation" = true`,
      );
    });

    it.each([
      [
        'datos de cancelación sin estar cancelada',
        `"cancelledAt" = now(), "cancelledByKind" = 'CLINIC', "cancelReasonCode" = 'OTHER', "noticeMinutes" = 0, "lateCancellation" = false`,
      ],
      [
        'hora sin quién ni aviso',
        `"status" = 'CANCELLED', "cancelledAt" = now()`,
      ],
      [
        'el personal sin motivo',
        `"status" = 'CANCELLED', "cancelledAt" = now(), "cancelledByKind" = 'STAFF_FOR_PATIENT', "noticeMinutes" = 10, "lateCancellation" = false`,
      ],
      [
        'texto sin motivo',
        `"status" = 'CANCELLED', "cancelledAt" = now(), "cancelledByKind" = 'PATIENT_LINK', "cancelReasonText" = 'x', "noticeMinutes" = 10, "lateCancellation" = false`,
      ],
      [
        'aviso negativo',
        `"status" = 'CANCELLED', "cancelledAt" = now(), "cancelledByKind" = 'CLINIC', "cancelReasonCode" = 'OTHER', "noticeMinutes" = -1, "lateCancellation" = false`,
      ],
      [
        'la clínica tardía',
        `"status" = 'CANCELLED', "cancelledAt" = now(), "cancelledByKind" = 'CLINIC', "cancelReasonCode" = 'CLINIC_RESCHEDULE', "noticeMinutes" = 10, "lateCancellation" = true`,
      ],
      ['hora de inasistencia sin estar en NO_SHOW', `"noShowMarkedAt" = now()`],
    ])('rechaza %s', async (_label, set) => {
      await expect(update(a, set)).rejects.toThrow(
        /appointments_cancellation_check/,
      );
    });

    it('NO_SHOW con su hora es válido', async () => {
      await update(a, `"status" = 'NO_SHOW', "noShowMarkedAt" = now()`);
    });
  });

  it('el índice parcial de incidencias del resumen existe', async () => {
    const [idx] = await raw.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'appointments_tenant_patient_incidents_idx'`;
    expect(idx.indexdef).toMatch(/WHERE .*deletedAt.* IS NULL/);
  });
});
