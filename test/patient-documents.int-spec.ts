import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

// DX-151, capa DB de patient_documents: RLS FORCE, FK compuestas, CHECKs
// (tamaño, sha256, dientes FDI), hash único entre los vigentes,
// inalterabilidad (trigger dx_patient_documents_immutable) y hora de subida
// del servidor en UTC. Cada caso escribe POR LA MISMA RUTA que la app
// (runWithTenant, rol dentalix_app); `raw` (DIRECT_URL, superusuario) solo
// siembra, lee y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const IMMUTABLE = /patient_documents es inalterable/;
const FK_VIOLATION = { code: 'P2003' };
const UNIQUE_VIOLATION = { code: 'P2002' };

interface Seeded {
  tenantId: string;
  locationId: string;
  patientId: string;
  userId: string;
}

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await raw.location.create({
    data: { tenantId: tenant.id, name: 'Sede' },
  });
  const patient = await raw.patient.create({
    data: { tenantId: tenant.id, firstName: 'Ana', lastName: subdomain },
  });
  const user = await raw.user.create({
    data: {
      email: `dr@${subdomain}.test`,
      passwordHash: 'x',
      fullName: 'Dra. Prueba',
    },
  });
  return {
    tenantId: tenant.id,
    locationId: location.id,
    patientId: patient.id,
    userId: user.id,
  };
}

let seq = 0;
/** sha256 hex distinto en cada llamada (contenido ficticio). */
function nextSha(): string {
  seq += 1;
  return createHash('sha256').update(`doc-${seq}`).digest('hex');
}

function docData(
  s: Seeded,
  extra: Partial<Prisma.PatientDocumentUncheckedCreateInput> = {},
): Prisma.PatientDocumentUncheckedCreateInput {
  seq += 1;
  return {
    tenantId: s.tenantId,
    patientId: s.patientId,
    locationId: s.locationId,
    category: 'XRAY',
    originalName: 'panoramica.png',
    mimeType: 'image/png',
    sizeBytes: 1024,
    sha256: nextSha(),
    storageKey: `tenants/${s.tenantId}/patients/${s.patientId}/documents/k-${seq}`,
    uploadedById: s.userId,
    ...extra,
  };
}

async function cleanup(seeds: Seeded[]): Promise<void> {
  const tenantIds = seeds.map((s) => s.tenantId);
  const where = { tenantId: { in: tenantIds } };
  // Superusuario (owner de test): el trigger le deja borrar (purga).
  await raw.patientDocument.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.user.deleteMany({
    where: { id: { in: seeds.map((s) => s.userId) } },
  });
  await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

async function purgeLeftovers(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: ['docs-int-a', 'docs-int-b'] } },
  });
  const users = await raw.user.findMany({
    where: { email: { in: ['dr@docs-int-a.test', 'dr@docs-int-b.test'] } },
  });
  const tenantIds = tenants.map((t) => t.id);
  if (tenantIds.length === 0 && users.length === 0) return;
  const where = { tenantId: { in: tenantIds } };
  await raw.patientDocument.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

describe('patient_documents: RLS, FK, CHECKs, hash único, inalterabilidad y hora del servidor (DX-151, int)', () => {
  let a: Seeded;
  let b: Seeded;
  let docA: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purgeLeftovers();
    a = await seedClinic('docs-int-a');
    b = await seedClinic('docs-int-b');
    docA = (
      await prisma.runWithTenant(a.tenantId, (tx) =>
        tx.patientDocument.create({
          data: docData(a, { originalName: 'compartido.pdf' }),
        }),
      )
    ).id;
    await prisma.runWithTenant(b.tenantId, (tx) =>
      tx.patientDocument.create({
        data: docData(b, { originalName: 'compartido.pdf' }),
      }),
    );
  });

  afterAll(async () => {
    await cleanup([a, b]);
    await raw.$disconnect();
    await appRole.$disconnect();
    await prisma.onModuleDestroy();
  });

  function asA<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(a.tenantId, fn);
  }

  /** SQL directo como dentalix_app, con el GUC de tenant como lo fija la app. */
  function asAppRole(sql: string, ...params: unknown[]) {
    return appRole.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
      return tx.$executeRawUnsafe(sql, ...params);
    });
  }

  /** INSERT por SQL como dentalix_app (clínica A) con los dientes dados. */
  function insertTeethSql(teeth: string[]) {
    const d = docData(a);
    return asAppRole(
      `INSERT INTO "patient_documents" ("id", "tenantId", "patientId", "locationId", "category",
         "originalName", "mimeType", "sizeBytes", "sha256", "storageKey", "toothNumbers", "uploadedById")
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'PHOTO',
         'foto.jpg', 'image/jpeg', 10, $4, $5, $6::text[], $7::uuid)`,
      a.tenantId,
      a.patientId,
      a.locationId,
      d.sha256,
      d.storageKey,
      teeth,
      a.userId,
    );
  }

  describe('RLS FORCE', () => {
    it('está activada y forzada', async () => {
      const [row] = await raw.$queryRaw<
        { rls: boolean; force: boolean }[]
      >`SELECT relrowsecurity AS rls, relforcerowsecurity AS force
        FROM pg_class WHERE relname = 'patient_documents'`;
      expect(row).toEqual({ rls: true, force: true });
    });

    it('A solo ve lo suyo, también buscando el mismo nombre de fichero', async () => {
      const seen = await asA((tx) =>
        tx.patientDocument.findMany({
          where: { originalName: 'compartido.pdf' },
        }),
      );
      expect(seen.map((d) => d.tenantId)).toEqual([a.tenantId]);
    });

    it('B no puede escribir con el tenantId de A (WITH CHECK)', async () => {
      await expect(
        prisma.runWithTenant(b.tenantId, (tx) =>
          tx.patientDocument.create({ data: docData(a) }),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('FK compuestas por tenant', () => {
    it.each([
      ['paciente', () => ({ patientId: b.patientId })],
      ['sede', () => ({ locationId: b.locationId })],
    ])('no admite el %s de otra clínica', async (_name, extra) => {
      await expect(
        asA((tx) => tx.patientDocument.create({ data: docData(a, extra()) })),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('por SQL el paciente de otra clínica da 23503', async () => {
      const d = docData(a);
      await expect(
        asAppRole(
          `INSERT INTO "patient_documents" ("id", "tenantId", "patientId", "locationId", "category",
             "originalName", "mimeType", "sizeBytes", "sha256", "storageKey", "uploadedById")
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'XRAY',
             'rx.png', 'image/png', 10, $4, $5, $6::uuid)`,
          a.tenantId,
          b.patientId,
          a.locationId,
          d.sha256,
          d.storageKey,
          a.userId,
        ),
      ).rejects.toThrow(/23503/);
    });
  });

  describe('CHECKs', () => {
    it.each([
      ['tamaño 0', { sizeBytes: 0 }, /patient_documents_size_range/],
      [
        'tamaño de más de 20 MB',
        { sizeBytes: 20 * 1024 * 1024 + 1 },
        /patient_documents_size_range/,
      ],
      [
        'sha256 en mayúsculas',
        { sha256: 'A'.repeat(64) },
        /patient_documents_sha256_hex/,
      ],
      [
        'sha256 corto',
        { sha256: 'a'.repeat(63) },
        /patient_documents_sha256_hex/,
      ],
      [
        'nombre en blanco',
        { originalName: '   ' },
        /patient_documents_original_name_len/,
      ],
      [
        'nombre de más de 255',
        { originalName: `${'x'.repeat(252)}.pdf` },
        /patient_documents_original_name_len/,
      ],
      [
        'notas de más de 500',
        { notes: 'n'.repeat(501) },
        /patient_documents_notes_len/,
      ],
      [
        'diente que no es FDI',
        { toothNumbers: ['99'] },
        /patient_documents_teeth/,
      ],
      [
        'más de 8 dientes',
        {
          toothNumbers: ['11', '12', '13', '14', '15', '16', '17', '18', '21'],
        },
        /patient_documents_teeth/,
      ],
      [
        'anulación sin motivo',
        { voidedAt: new Date() },
        /patient_documents_void_check/,
      ],
    ] as const)('rechaza %s', async (_name, extra, error) => {
      await expect(
        asA((tx) =>
          tx.patientDocument.create({
            data: docData(
              a,
              extra as unknown as Partial<Prisma.PatientDocumentUncheckedCreateInput>,
            ),
          }),
        ),
      ).rejects.toThrow(error);
    });

    it('acepta 20 MB justos, sin dientes, con dos dientes FDI y con 8 (temporales incluidos)', async () => {
      const rows = await asA(async (tx) => [
        await tx.patientDocument.create({
          data: docData(a, { sizeBytes: 20 * 1024 * 1024 }),
        }),
        await tx.patientDocument.create({ data: docData(a) }),
        await tx.patientDocument.create({
          data: docData(a, { toothNumbers: ['11', '21'] }),
        }),
        await tx.patientDocument.create({
          data: docData(a, {
            toothNumbers: ['18', '28', '38', '48', '55', '65', '75', '85'],
          }),
        }),
      ]);
      expect(rows.map((r) => r.toothNumbers)).toEqual([
        [],
        [],
        ['11', '21'],
        ['18', '28', '38', '48', '55', '65', '75', '85'],
      ]);
    });

    it('por SQL un diente fuera de FDI, un NULL o 9 dientes dan 23514', async () => {
      await expect(insertTeethSql(['99'])).rejects.toThrow(/23514/);
      await expect(insertTeethSql(['11', '19'])).rejects.toThrow(/23514/);
      await expect(insertTeethSql(['56'])).rejects.toThrow(/23514/);
      await expect(
        asAppRole(
          `INSERT INTO "patient_documents" ("id", "tenantId", "patientId", "locationId", "category",
             "originalName", "mimeType", "sizeBytes", "sha256", "storageKey", "toothNumbers", "uploadedById")
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'PHOTO',
             'foto.jpg', 'image/jpeg', 10, $4, $5, ARRAY['11', NULL]::text[], $6::uuid)`,
          a.tenantId,
          a.patientId,
          a.locationId,
          nextSha(),
          `k-null-${seq}`,
          a.userId,
        ),
      ).rejects.toThrow(/23514/);
      await expect(
        insertTeethSql(['11', '12', '13', '14', '15', '16', '17', '18', '21']),
      ).rejects.toThrow(/23514/);
      await expect(insertTeethSql(['11', '21'])).resolves.toBe(1);
      await expect(insertTeethSql([])).resolves.toBe(1);
    });
  });

  describe('hash único entre los vigentes del paciente', () => {
    it('rechaza el mismo sha256 vigente; anulado el primero, deja volver a subirlo', async () => {
      const sha256 = nextSha();
      const first = await asA((tx) =>
        tx.patientDocument.create({ data: docData(a, { sha256 }) }),
      );
      await expect(
        asA((tx) =>
          tx.patientDocument.create({ data: docData(a, { sha256 }) }),
        ),
      ).rejects.toMatchObject(UNIQUE_VIOLATION);
      // Mismo contenido en OTRO paciente de otra clínica: no choca.
      await expect(
        prisma.runWithTenant(b.tenantId, (tx) =>
          tx.patientDocument.create({ data: docData(b, { sha256 }) }),
        ),
      ).resolves.toMatchObject({ sha256 });
      await asA((tx) =>
        tx.patientDocument.update({
          where: { id: first.id },
          data: {
            voidedAt: new Date(),
            voidedById: a.userId,
            voidReason: 'Subido al paciente equivocado',
          },
        }),
      );
      await expect(
        asA((tx) =>
          tx.patientDocument.create({ data: docData(a, { sha256 }) }),
        ),
      ).resolves.toMatchObject({ sha256, voidedAt: null });
    });

    it('la clave del bucket es única', async () => {
      const storageKey = `dup-key-${nextSha()}`;
      await asA((tx) =>
        tx.patientDocument.create({ data: docData(a, { storageKey }) }),
      );
      await expect(
        asA((tx) =>
          tx.patientDocument.create({ data: docData(a, { storageKey }) }),
        ),
      ).rejects.toMatchObject(UNIQUE_VIOLATION);
    });
  });

  describe('inalterable (trigger)', () => {
    it('rechaza editar la categoría por Prisma y el nombre por SQL', async () => {
      await expect(
        asA((tx) =>
          tx.patientDocument.update({
            where: { id: docA },
            data: { category: 'PHOTO' },
          }),
        ),
      ).rejects.toThrow(IMMUTABLE);
      await expect(
        asAppRole(
          `UPDATE "patient_documents" SET "originalName" = 'otro.pdf' WHERE "id" = $1::uuid`,
          docA,
        ),
      ).rejects.toThrow(IMMUTABLE);
    });

    it('rechaza el DELETE de la app, también suplantando pg_roles (SEC-032)', async () => {
      await expect(
        asAppRole(
          `DELETE FROM "patient_documents" WHERE "id" = $1::uuid`,
          docA,
        ),
      ).rejects.toThrow(IMMUTABLE);
      await expect(
        appRole.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
          await tx.$executeRawUnsafe(
            'CREATE TEMP TABLE pg_roles (rolname name, rolsuper boolean) ON COMMIT DROP',
          );
          await tx.$executeRawUnsafe(
            'INSERT INTO pg_roles VALUES (current_user, true)',
          );
          return tx.$executeRawUnsafe(
            `DELETE FROM "patient_documents" WHERE "id" = $1::uuid`,
            docA,
          );
        }),
      ).rejects.toThrow(IMMUTABLE);
    });

    it('rechaza el UPDATE de contenido incluso al superusuario', async () => {
      await expect(
        raw.$executeRawUnsafe(
          `UPDATE "patient_documents" SET "notes" = 'x' WHERE "id" = $1::uuid`,
          docA,
        ),
      ).rejects.toThrow(IMMUTABLE);
      await expect(
        raw.$executeRawUnsafe(
          `UPDATE "patient_documents" SET "uploadedAt" = '2020-01-01' WHERE "id" = $1::uuid`,
          docA,
        ),
      ).rejects.toThrow(IMMUTABLE);
    });

    it('deja anular una vez, sin tocar nada más; la segunda vez falla', async () => {
      await expect(
        asA((tx) =>
          tx.patientDocument.update({
            where: { id: docA },
            data: {
              voidedAt: new Date(),
              voidedById: a.userId,
              voidReason: 'Duplicado',
              notes: 'cambio colado',
            },
          }),
        ),
      ).rejects.toThrow(IMMUTABLE);
      await asA((tx) =>
        tx.patientDocument.update({
          where: { id: docA },
          data: {
            voidedAt: new Date(),
            voidedById: a.userId,
            voidReason: 'Paciente equivocado',
          },
        }),
      );
      await expect(
        asA((tx) =>
          tx.patientDocument.update({
            where: { id: docA },
            data: { voidReason: 'Cambio el motivo' },
          }),
        ),
      ).rejects.toThrow(IMMUTABLE);
      await expect(
        asA((tx) =>
          tx.patientDocument.update({
            where: { id: docA },
            data: { voidedAt: null, voidedById: null, voidReason: null },
          }),
        ),
      ).rejects.toThrow(IMMUTABLE);
      const row = await raw.patientDocument.findUniqueOrThrow({
        where: { id: docA },
      });
      expect(row).toMatchObject({
        originalName: 'compartido.pdf',
        category: 'XRAY',
        notes: null,
        voidReason: 'Paciente equivocado',
      });
    });
  });

  describe('hora del servidor', () => {
    it('uploadedAt y createdAt los pone el servidor en UTC aunque la API mande otra y la sesión esté en Bogotá', async () => {
      const row = await appRole.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'America/Bogota'`);
        const d = docData(a);
        const [inserted] = await tx.$queryRawUnsafe<
          { upload_drift: number; created_drift: number; same: boolean }[]
        >(
          `INSERT INTO "patient_documents" ("id", "tenantId", "patientId", "locationId", "category",
             "originalName", "mimeType", "sizeBytes", "sha256", "storageKey", "uploadedById",
             "uploadedAt", "createdAt")
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'REPORT',
             'informe.pdf', 'application/pdf', 10, $4, $5, $6::uuid,
             '2001-01-01', '2001-01-01')
           RETURNING
             abs(extract(epoch FROM ("uploadedAt" - (now() AT TIME ZONE 'UTC'))))::float8 AS upload_drift,
             abs(extract(epoch FROM ("createdAt" - (now() AT TIME ZONE 'UTC'))))::float8 AS created_drift,
             "uploadedAt" = "createdAt" AS same`,
          a.tenantId,
          a.patientId,
          a.locationId,
          d.sha256,
          d.storageKey,
          a.userId,
        );
        return inserted;
      });
      expect(row.upload_drift).toBeLessThan(1);
      expect(row.created_drift).toBeLessThan(1);
      expect(row.same).toBe(true);
    });

    it('por Prisma, un uploadedAt del cliente no cuenta', async () => {
      const before = Date.now();
      const row = await asA((tx) =>
        tx.patientDocument.create({
          data: docData(a, { uploadedAt: new Date('2001-01-01T00:00:00Z') }),
        }),
      );
      expect(row.uploadedAt.getTime()).toBeGreaterThan(before - 5_000);
    });
  });

  describe('retención', () => {
    it('un paciente con documentos no se puede borrar en duro (RESTRICT)', async () => {
      await expect(
        asA((tx) => tx.patient.delete({ where: { id: a.patientId } })),
      ).rejects.toThrow();
    });
  });
});
