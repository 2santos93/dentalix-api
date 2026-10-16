import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

// DX-038, capa DB de la historia clínica inalterable (Res. 1995/1999 art. 18).
// Cada caso escribe POR LA MISMA RUTA que la app (runWithTenant, rol
// dentalix_app, sujeto a RLS) o con una conexión directa como dentalix_app;
// `raw` (DIRECT_URL, superusuario) solo siembra y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
// Conexión directa como el rol de la app, sin pasar por PrismaService.
const appRole = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const REASON = 'Pieza dental mal transcrita en la nota';
const IMMUTABLE = /inalterable/;
const FK_VIOLATION = { code: 'P2003' };

interface Seeded {
  tenantId: string;
  patientId: string;
  otherPatientId: string;
  entryId: string;
  otherPatientEntryId: string;
  historyId: string;
  addendumId: string;
}

let authorId: string;

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const patient = await raw.patient.create({
    data: { tenantId, firstName: 'Ana', lastName: subdomain },
  });
  const other = await raw.patient.create({
    data: { tenantId, firstName: 'Otra', lastName: subdomain },
  });
  return prisma.runWithTenant(tenantId, async (tx) => {
    const entry = await tx.clinicalEntry.create({
      data: {
        tenantId,
        patientId: patient.id,
        entryDate: new Date('2026-10-01T10:00:00Z'),
        notes: 'Resina en 46',
        performedById: authorId,
      },
    });
    const otherEntry = await tx.clinicalEntry.create({
      data: {
        tenantId,
        patientId: other.id,
        entryDate: new Date('2026-10-01T10:00:00Z'),
        notes: 'Profilaxis',
        performedById: authorId,
      },
    });
    const history = await tx.medicalHistoryVersion.create({
      data: {
        tenantId,
        patientId: patient.id,
        version: 1,
        notes: 'Sin alergias',
      },
    });
    const addendum = await tx.clinicalEntryAddendum.create({
      data: {
        tenantId,
        patientId: patient.id,
        clinicalEntryId: entry.id,
        reason: REASON,
        text: 'Es la 36, no la 46.',
        authorId,
      },
    });
    return {
      tenantId,
      patientId: patient.id,
      otherPatientId: other.id,
      entryId: entry.id,
      otherPatientEntryId: otherEntry.id,
      historyId: history.id,
      addendumId: addendum.id,
    };
  });
}

async function cleanup(tenantIds: string[]): Promise<void> {
  const where = { tenantId: { in: tenantIds } };
  // Superusuario: el trigger deja la purga administrativa.
  await raw.clinicalEntryAddendum.deleteMany({ where });
  await raw.clinicalEntry.deleteMany({ where });
  await raw.medicalHistoryVersion.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

function addendumData(
  s: Seeded,
  extra: Partial<Prisma.ClinicalEntryAddendumUncheckedCreateInput> = {},
): Prisma.ClinicalEntryAddendumUncheckedCreateInput {
  return {
    tenantId: s.tenantId,
    patientId: s.patientId,
    clinicalEntryId: s.entryId,
    reason: REASON,
    text: 'Corrección',
    authorId,
    ...extra,
  };
}

describe('historia clínica inalterable + adendas (DX-038, int)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    await prisma.onModuleInit();
    authorId = (
      await raw.user.create({
        data: {
          email: 'dx038-int-autor@example.com',
          passwordHash: 'x',
          fullName: 'Dra. Autora',
        },
      })
    ).id;
    a = await seedClinic('dx038-int-a');
    b = await seedClinic('dx038-int-b');
  });

  afterAll(async () => {
    await cleanup([a.tenantId, b.tenantId]);
    await raw.user.delete({ where: { id: authorId } });
    await raw.$disconnect();
    await appRole.$disconnect();
    await prisma.onModuleDestroy();
  });

  function asA<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(a.tenantId, fn);
  }

  /** SQL directo como dentalix_app, con el GUC de tenant como lo fija la app. */
  function asAppRole(sql: string, id: string) {
    return appRole.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
      return tx.$executeRawUnsafe(sql, id);
    });
  }

  describe.each([
    ['clinical_entries', 'notes', () => a.entryId],
    ['medical_history_versions', 'notes', () => a.historyId],
    ['clinical_entry_addenda', 'text', () => a.addendumId],
  ])('%s', (table, column, id) => {
    it('rechaza el UPDATE por SQL como rol de la app', async () => {
      await expect(
        asAppRole(
          `UPDATE "${table}" SET "${column}" = 'alterado' WHERE "id" = $1::uuid`,
          id(),
        ),
      ).rejects.toThrow(IMMUTABLE);
    });

    it('rechaza el DELETE por SQL como rol de la app', async () => {
      await expect(
        asAppRole(`DELETE FROM "${table}" WHERE "id" = $1::uuid`, id()),
      ).rejects.toThrow(IMMUTABLE);
    });

    it('rechaza el DELETE aunque una tabla temporal suplante pg_roles', async () => {
      // pg_temp va ANTES que pg_catalog en el search_path por defecto: sin
      // search_path fijo en la función, el rol de la app se haría pasar por
      // superusuario y borraría la HC.
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
            `DELETE FROM "${table}" WHERE "id" = $1::uuid`,
            id(),
          );
        }),
      ).rejects.toThrow(IMMUTABLE);
    });

    it('rechaza el UPDATE incluso al superusuario (solo la purga puede borrar)', async () => {
      await expect(
        raw.$executeRawUnsafe(
          `UPDATE "${table}" SET "createdAt" = now() - interval '1 day' WHERE "id" = $1::uuid`,
          id(),
        ),
      ).rejects.toThrow(IMMUTABLE);
    });

    it('rechaza el TRUNCATE del rol de la app', async () => {
      await expect(
        appRole.$executeRawUnsafe(`TRUNCATE "${table}" CASCADE`),
      ).rejects.toThrow();
    });

    it('la fila sigue intacta', async () => {
      const rows = await raw.$queryRawUnsafe<{ v: string }[]>(
        `SELECT "${column}" AS v FROM "${table}" WHERE "id" = $1::uuid`,
        id(),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].v).not.toBe('alterado');
    });
  });

  it('Prisma (update, también el borrado blando) tampoco puede tocar una evolución', async () => {
    await expect(
      asA((tx) =>
        tx.clinicalEntry.update({
          where: { id: a.entryId },
          data: { notes: 'alterado' },
        }),
      ),
    ).rejects.toThrow(IMMUTABLE);
    // Ni siquiera el retiro "en blando" (deletedAt): la HC no se retira.
    await expect(
      asA((tx) =>
        tx.clinicalEntry.update({
          where: { id: a.entryId },
          data: { deletedAt: new Date() },
        }),
      ),
    ).rejects.toThrow(IMMUTABLE);
  });

  describe('autoría y fecha del servidor', () => {
    it('una evolución nueva sin autor se rechaza', async () => {
      await expect(
        asA((tx) =>
          tx.clinicalEntry.create({
            data: {
              tenantId: a.tenantId,
              patientId: a.patientId,
              entryDate: new Date(),
              notes: 'Sin autor',
            },
          }),
        ),
      ).rejects.toThrow(/clinical_entries_author_required/);
    });

    it('la fecha de registro la pone la BD aunque el INSERT traiga otra', async () => {
      const before = Date.now();
      const fake = new Date('2001-01-01T00:00:00Z');
      const out = await asA(async (tx) => ({
        entry: await tx.clinicalEntry.create({
          data: {
            tenantId: a.tenantId,
            patientId: a.patientId,
            entryDate: new Date(),
            notes: 'Fecha falsa',
            performedById: authorId,
            createdAt: fake,
          },
        }),
        addendum: await tx.clinicalEntryAddendum.create({
          data: addendumData(a, { createdAt: fake }),
        }),
      }));
      for (const row of [out.entry, out.addendum]) {
        expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before - 60_000);
      }
    });
  });

  describe('adendas: FK compuestas, RLS y CHECKs', () => {
    it('no admite la evolución de otro paciente de la misma clínica', async () => {
      await expect(
        asA((tx) =>
          tx.clinicalEntryAddendum.create({
            data: addendumData(a, { clinicalEntryId: a.otherPatientEntryId }),
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('no admite la evolución ni el paciente de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.clinicalEntryAddendum.create({
            data: addendumData(a, { clinicalEntryId: b.entryId }),
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
      await expect(
        asA((tx) =>
          tx.clinicalEntryAddendum.create({
            data: addendumData(a, {
              patientId: b.patientId,
              clinicalEntryId: b.entryId,
            }),
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('la clínica B no ve las adendas de A', async () => {
      const seen = await prisma.runWithTenant(b.tenantId, (tx) =>
        tx.clinicalEntryAddendum.findMany(),
      );
      expect(seen.map((r) => r.tenantId)).toEqual([b.tenantId]);
    });

    it('no deja insertar con el tenantId de otra clínica (WITH CHECK)', async () => {
      await expect(
        asA((tx) =>
          tx.clinicalEntryAddendum.create({
            data: addendumData(b),
          }),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('exige motivo de al menos 10 caracteres y texto no vacío', async () => {
      await expect(
        asA((tx) =>
          tx.clinicalEntryAddendum.create({
            data: addendumData(a, { reason: '   corto  ' }),
          }),
        ),
      ).rejects.toThrow(/clinical_entry_addenda_reason_len/);
      await expect(
        asA((tx) =>
          tx.clinicalEntryAddendum.create({
            data: addendumData(a, { text: '   ' }),
          }),
        ),
      ).rejects.toThrow(/clinical_entry_addenda_text_len/);
    });
  });
});
