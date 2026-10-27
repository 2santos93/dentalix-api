import { Prisma, PrismaClient } from '@prisma/client';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-222, capa DB de las indicaciones postoperatorias: plantillas, vínculos a
// procedimientos/tipos de cita y entregas INALTERABLES (solo se marca la
// primera apertura del enlace). Las escrituras van como el rol de la app
// (dentalix_app, sujeto a RLS) con el GUC de tenant como lo fija la app;
// `raw` (DIRECT_URL, superusuario) solo siembra, consulta el catálogo y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const IMMUTABLE = /inalterable/;
const TABLES = [
  'post_op_instruction_templates',
  'post_op_instruction_template_links',
  'post_op_instruction_deliveries',
];

interface Seeded {
  tenantId: string;
  locationId: string;
  patientId: string;
  otherPatientId: string;
  appointmentId: string;
  otherPatientAppointmentId: string;
  appointmentTypeId: string;
  templateId: string;
}

let userId: string;

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

async function insertTemplate(
  tx: Prisma.TransactionClient,
  tenantId: string,
  code: string,
): Promise<string> {
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "post_op_instruction_templates"
       ("id", "tenantId", "code", "title", "body", "updatedAt")
     VALUES (gen_random_uuid(), $1::uuid, $2, 'Exodoncia simple',
             'Hola {{paciente}}, muerde la gasa 30 minutos.', now())
     RETURNING "id"`,
    tenantId,
    code,
  );
  return rows[0].id;
}

interface DeliveryInput {
  patientId?: string;
  appointmentId?: string;
  deliveredAt?: string;
  createdAt?: string;
  tokenHash?: string | null;
}

async function insertDelivery(
  tx: Prisma.TransactionClient,
  s: Seeded,
  input: DeliveryInput = {},
): Promise<string> {
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "post_op_instruction_deliveries"
       ("id", "tenantId", "patientId", "appointmentId", "locationId",
        "templateId", "templateCode", "templateTitle", "templateVersion",
        "channel", "renderedText", "deliveredById", "deliveredByName",
        "deliveredAt", "createdAt", "tokenHash", "tokenExpiresAt")
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid,
             $5::uuid, 'POI-EXO', 'Exodoncia simple', 1,
             'EMAIL', 'Hola Ana, muerde la gasa 30 minutos.', $6::uuid,
             'Dra. Autora', $7::timestamp, $8::timestamp, $9,
             CASE WHEN $9::text IS NULL THEN NULL
                  ELSE now() + interval '30 days' END)
     RETURNING "id"`,
    s.tenantId,
    input.patientId ?? s.patientId,
    input.appointmentId ?? s.appointmentId,
    s.locationId,
    s.templateId,
    userId,
    input.deliveredAt ?? new Date().toISOString(),
    input.createdAt ?? new Date().toISOString(),
    input.tokenHash === undefined ? null : input.tokenHash,
  );
  return rows[0].id;
}

function hash(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const location = await raw.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
      tenantId,
      name: `Sede ${subdomain}`,
    }),
  });
  const patient = await raw.patient.create({
    data: { tenantId, firstName: 'Ana', lastName: subdomain },
  });
  const other = await raw.patient.create({
    data: { tenantId, firstName: 'Otra', lastName: subdomain },
  });
  const type = await raw.appointmentType.create({
    data: {
      tenantId,
      name: 'Exodoncia',
      durationMinutes: 30,
      color: '#AA3300',
    },
  });
  const appointment = (patientId: string, hour: number) =>
    raw.appointment.create({
      data: {
        tenantId,
        locationId: location.id,
        patientId,
        providerId: userId,
        appointmentTypeId: type.id,
        start: new Date(Date.UTC(2026, 9, 20, hour, 0)),
        end: new Date(Date.UTC(2026, 9, 20, hour, 30)),
      },
    });
  const appt = await appointment(patient.id, 14);
  const otherAppt = await appointment(other.id, 15);
  const templateId = await asApp(tenantId, (tx) =>
    insertTemplate(tx, tenantId, 'POI-EXO'),
  );
  return {
    tenantId,
    locationId: location.id,
    patientId: patient.id,
    otherPatientId: other.id,
    appointmentId: appt.id,
    otherPatientAppointmentId: otherAppt.id,
    appointmentTypeId: type.id,
    templateId,
  };
}

const SUBDOMAINS = ['dx222-int-a', 'dx222-int-b'];
const USER_EMAIL = 'dx222-int-autora@example.com';

/** Purga por subdominio: también deja limpio un arranque a medias. */
async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const tenantIds = tenants.map((t) => t.id);
  if (tenantIds.length > 0) {
    // Superusuario sin `app.current_tenant`: el trigger deja la purga.
    for (const table of [...TABLES].reverse()) {
      await raw.$executeRawUnsafe(
        `DELETE FROM "${table}" WHERE "tenantId" = ANY($1::uuid[])`,
        tenantIds,
      );
    }
    const where = { tenantId: { in: tenantIds } };
    await raw.appointment.deleteMany({ where });
    await raw.appointmentType.deleteMany({ where });
    await raw.patient.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  }
  await raw.user.deleteMany({ where: { email: USER_EMAIL } });
}

describe('indicaciones postoperatorias: plantillas, vínculos y entregas (DX-222, int)', () => {
  let a: Seeded;
  let b: Seeded;
  let deliveryId: string;

  beforeAll(async () => {
    await cleanup();
    userId = (
      await raw.user.create({
        data: {
          email: USER_EMAIL,
          passwordHash: 'x',
          fullName: 'Dra. Autora',
        },
      })
    ).id;
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
    deliveryId = await asApp(a.tenantId, (tx) =>
      insertDelivery(tx, a, { tokenHash: hash('a') }),
    );
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await appRole.$disconnect();
  });

  it('las tres FK de entrega tienen índices válidos con las columnas en orden', async () => {
    const rows = await raw.$queryRaw<
      { name: string; columns: string[]; valid: boolean; ready: boolean }[]
    >`
      SELECT i.relname AS name, x.indisvalid AS valid, x.indisready AS ready,
             array_agg(a.attname::text ORDER BY k.ordinality) AS columns
      FROM pg_index x
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
      JOIN pg_class i ON i.oid = x.indexrelid
      CROSS JOIN LATERAL unnest(x.indkey) WITH ORDINALITY k(attnum, ordinality)
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE t.relname = 'post_op_instruction_deliveries'
        AND i.relname IN ('post_op_instruction_deliveries_template_idx',
                         'post_op_instruction_deliveries_location_idx',
                         'post_op_instruction_deliveries_delivered_by_idx')
      GROUP BY i.relname, x.indisvalid, x.indisready ORDER BY i.relname`;
    expect(rows).toEqual([
      {
        name: 'post_op_instruction_deliveries_delivered_by_idx',
        columns: ['deliveredById'],
        valid: true,
        ready: true,
      },
      {
        name: 'post_op_instruction_deliveries_location_idx',
        columns: ['tenantId', 'locationId'],
        valid: true,
        ready: true,
      },
      {
        name: 'post_op_instruction_deliveries_template_idx',
        columns: ['tenantId', 'templateId'],
        valid: true,
        ready: true,
      },
    ]);
  });

  describe('entrega inalterable', () => {
    it('rechaza el UPDATE del texto por SQL como rol de la app', async () => {
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE "post_op_instruction_deliveries"
                SET "renderedText" = 'alterado' WHERE "id" = $1::uuid`,
            deliveryId,
          ),
        ),
      ).rejects.toThrow(IMMUTABLE);
    });

    it('rechaza el UPDATE incluso al superusuario', async () => {
      await expect(
        raw.$executeRawUnsafe(
          `UPDATE "post_op_instruction_deliveries"
              SET "templateVersion" = 9 WHERE "id" = $1::uuid`,
          deliveryId,
        ),
      ).rejects.toThrow(IMMUTABLE);
    });

    it('permite marcar firstOpenedAt una sola vez', async () => {
      const id = await asApp(a.tenantId, (tx) =>
        insertDelivery(tx, a, { tokenHash: hash('b') }),
      );
      const first = await asApp(a.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "post_op_instruction_deliveries"
              SET "firstOpenedAt" = now() WHERE "id" = $1::uuid`,
          id,
        ),
      );
      expect(first).toBe(1);
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE "post_op_instruction_deliveries"
                SET "firstOpenedAt" = now() + interval '1 day'
              WHERE "id" = $1::uuid`,
            id,
          ),
        ),
      ).rejects.toThrow(IMMUTABLE);
      // Ni de vuelta a NULL.
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE "post_op_instruction_deliveries"
                SET "firstOpenedAt" = NULL WHERE "id" = $1::uuid`,
            id,
          ),
        ),
      ).rejects.toThrow(IMMUTABLE);
    });

    it('no deja colar otro cambio junto a la primera apertura', async () => {
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE "post_op_instruction_deliveries"
                SET "firstOpenedAt" = now(),
                    "tokenExpiresAt" = now() + interval '365 days'
              WHERE "id" = $1::uuid`,
            deliveryId,
          ),
        ),
      ).rejects.toThrow(IMMUTABLE);
    });

    it('rechaza DELETE y TRUNCATE como rol de la app', async () => {
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `DELETE FROM "post_op_instruction_deliveries" WHERE "id" = $1::uuid`,
            deliveryId,
          ),
        ),
      ).rejects.toThrow(IMMUTABLE);
      await expect(
        appRole.$executeRawUnsafe(
          'TRUNCATE "post_op_instruction_deliveries" CASCADE',
        ),
      ).rejects.toThrow(
        /permission denied for table post_op_instruction_deliveries|inalterable/i,
      );
      const rows = await raw.$queryRawUnsafe<{ t: string }[]>(
        `SELECT "renderedText" AS t FROM "post_op_instruction_deliveries"
          WHERE "id" = $1::uuid`,
        deliveryId,
      );
      expect(rows).toEqual([{ t: 'Hola Ana, muerde la gasa 30 minutos.' }]);
    });

    it('deliveredAt y createdAt los pone el servidor aunque el INSERT traiga otra fecha', async () => {
      const id = await asApp(a.tenantId, (tx) =>
        insertDelivery(tx, a, {
          deliveredAt: '2000-01-01T00:00:00Z',
          createdAt: '2000-01-01T00:00:00Z',
        }),
      );
      const rows = await raw.$queryRawUnsafe<{ fresh: boolean }[]>(
        `SELECT "deliveredAt" > now() - interval '1 minute'
                AND "createdAt" > now() - interval '1 minute' AS fresh
           FROM "post_op_instruction_deliveries" WHERE "id" = $1::uuid`,
        id,
      );
      expect(rows).toEqual([{ fresh: true }]);
    });

    it('el hash del enlace es único y va con su caducidad', async () => {
      await expect(
        asApp(a.tenantId, (tx) =>
          insertDelivery(tx, a, { tokenHash: hash('a') }),
        ),
      ).rejects.toThrow(/tokenHash|unique|duplicate/i);
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO "post_op_instruction_deliveries"
               ("id", "tenantId", "patientId", "appointmentId", "locationId",
                "templateId", "templateCode", "templateTitle", "templateVersion",
                "channel", "renderedText", "deliveredById", "deliveredByName",
                "tokenHash")
             VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid,
                     $5::uuid, 'POI-EXO', 'Exodoncia', 1, 'EMAIL', 'Texto',
                     $6::uuid, 'Dra. Autora', $7)`,
            a.tenantId,
            a.patientId,
            a.appointmentId,
            a.locationId,
            a.templateId,
            userId,
            hash('c'),
          ),
        ),
      ).rejects.toThrow(/post_op_instruction_deliveries_token_check/);
    });
  });

  describe('FK compuestas y RLS', () => {
    it('la cita tiene que ser del mismo paciente y de la misma clínica', async () => {
      await expect(
        asApp(a.tenantId, (tx) =>
          insertDelivery(tx, a, { appointmentId: a.otherPatientAppointmentId }),
        ),
      ).rejects.toThrow(/foreign key/);
      await expect(
        asApp(a.tenantId, (tx) =>
          insertDelivery(tx, a, {
            patientId: b.patientId,
            appointmentId: b.appointmentId,
          }),
        ),
      ).rejects.toThrow(/foreign key/);
    });

    it('la clínica B no ve las entregas ni las plantillas de A', async () => {
      const seen = await asApp(b.tenantId, (tx) =>
        tx.$queryRawUnsafe<{ tenantId: string }[]>(
          `SELECT "tenantId" FROM "post_op_instruction_deliveries"
           UNION ALL
           SELECT "tenantId" FROM "post_op_instruction_templates"`,
        ),
      );
      expect(seen.map((r) => r.tenantId)).toEqual([b.tenantId]);
    });

    it('no deja insertar con el tenantId de otra clínica (WITH CHECK)', async () => {
      await expect(
        asApp(a.tenantId, (tx) => insertTemplate(tx, b.tenantId, 'POI-OTRA')),
      ).rejects.toThrow(/row-level security/);
    });

    it('las tres tablas tienen RLS FORCE y policy tenant_isolation', async () => {
      const rows = await raw.$queryRawUnsafe<
        { relname: string; rls: boolean; force: boolean; policies: string[] }[]
      >(
        `SELECT c.relname, c.relrowsecurity AS rls,
                c.relforcerowsecurity AS force,
                COALESCE(array_agg(p.policyname::text)
                         FILTER (WHERE p.policyname IS NOT NULL), '{}') AS policies
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
           LEFT JOIN pg_policies p
             ON p.schemaname = 'public' AND p.tablename = c.relname
          WHERE c.relname = ANY($1::text[])
          GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
          ORDER BY c.relname`,
        TABLES,
      );
      expect(rows).toEqual(
        [...TABLES].sort().map((relname) => ({
          relname,
          rls: true,
          force: true,
          policies: ['tenant_isolation'],
        })),
      );
    });
  });

  describe('plantillas y vínculos', () => {
    function insertLink(
      tx: Prisma.TransactionClient,
      s: Seeded,
      catalogItemId: string | null,
      appointmentTypeId: string | null,
      templateId = s.templateId,
    ) {
      return tx.$executeRawUnsafe(
        `INSERT INTO "post_op_instruction_template_links"
           ("id", "tenantId", "templateId", "catalogItemId", "appointmentTypeId")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
        s.tenantId,
        templateId,
        catalogItemId,
        appointmentTypeId,
      );
    }

    it('un vínculo apunta a exactamente un procedimiento o un tipo de cita', async () => {
      await expect(
        asApp(a.tenantId, (tx) => insertLink(tx, a, null, null)),
      ).rejects.toThrow(/post_op_instruction_template_links_target_check/);
      await expect(
        asApp(a.tenantId, (tx) =>
          insertLink(tx, a, a.patientId, a.appointmentTypeId),
        ),
      ).rejects.toThrow(/post_op_instruction_template_links_target_check/);
    });

    it('el mismo vínculo no se repite y el tipo de cita es de la misma clínica', async () => {
      await asApp(a.tenantId, (tx) =>
        insertLink(tx, a, null, a.appointmentTypeId),
      );
      await expect(
        asApp(a.tenantId, (tx) => insertLink(tx, a, null, a.appointmentTypeId)),
      ).rejects.toThrow(/unique|duplicate/i);
      const catalogItemId = '00000000-0000-4000-8000-000000000222';
      await asApp(a.tenantId, (tx) => insertLink(tx, a, catalogItemId, null));
      await expect(
        asApp(a.tenantId, (tx) => insertLink(tx, a, catalogItemId, null)),
      ).rejects.toThrow(/unique|duplicate/i);
      await expect(
        asApp(a.tenantId, (tx) => insertLink(tx, a, null, b.appointmentTypeId)),
      ).rejects.toThrow(/foreign key/);
    });

    it('borrar una plantilla se lleva sus vínculos, pero no si ya se entregó', async () => {
      const spareId = await asApp(a.tenantId, async (tx) => {
        const id = await insertTemplate(tx, a.tenantId, 'POI-ENDO');
        await insertLink(tx, a, null, a.appointmentTypeId, id);
        return id;
      });
      await asApp(a.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `DELETE FROM "post_op_instruction_templates" WHERE "id" = $1::uuid`,
          spareId,
        ),
      );
      const links = await raw.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "post_op_instruction_template_links"
          WHERE "templateId" = $1::uuid`,
        spareId,
      );
      expect(links).toEqual([{ n: 0 }]);
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `DELETE FROM "post_op_instruction_templates" WHERE "id" = $1::uuid`,
            a.templateId,
          ),
        ),
      ).rejects.toThrow(/foreign key/);
    });

    it('el código es único por clínica y respeta el formato', async () => {
      await expect(
        asApp(a.tenantId, (tx) => insertTemplate(tx, a.tenantId, 'POI-EXO')),
      ).rejects.toThrow(/unique|duplicate/i);
      await expect(
        asApp(a.tenantId, (tx) => insertTemplate(tx, a.tenantId, 'poi exo')),
      ).rejects.toThrow(/post_op_instruction_templates_code_check/);
      // Otra clínica puede usar el mismo código.
      await expect(
        asApp(b.tenantId, (tx) => insertTemplate(tx, b.tenantId, 'POI-ENDO')),
      ).resolves.toEqual(expect.any(String));
    });
  });

  it('la sede admite un teléfono de hasta 40 caracteres', async () => {
    const setPhone = (phone: string) =>
      raw.$executeRawUnsafe(
        `UPDATE "locations" SET "phone" = $1 WHERE "id" = $2::uuid`,
        phone,
        a.locationId,
      );
    await expect(setPhone('+57 601 555 0101')).resolves.toBe(1);
    await expect(setPhone('1'.repeat(41))).rejects.toThrow(
      /locations_phone_length_check/,
    );
  });
});
