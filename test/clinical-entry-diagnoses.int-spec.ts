import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { seedIcd10Codes } from '../src/modules/reference/infrastructure/seed-icd10-codes';
import { ICD10_ORAL_CODES } from '../src/modules/reference/domain/icd10-oral-codes';

// DX-212, capa BD de los diagnósticos CIE-10 de una evolución: inalterables
// (trigger con search_path fijo, SEC-032), solo junto con su evolución, RLS
// FORZADA y FK compuestas. Cada caso escribe como la app (runWithTenant, rol
// dentalix_app) o con una conexión directa como dentalix_app; `raw`
// (DIRECT_URL, superusuario) solo siembra y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const IMMUTABLE = /inalterable/;

interface Clinic {
  tenantId: string;
  patientId: string;
  otherPatientId: string;
  entryId: string;
  diagnosisId: string;
}

let authorId: string;

/** Evolución + diagnóstico principal en UNA transacción, como la app. */
async function seedClinic(subdomain: string): Promise<Clinic> {
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
        entryDate: new Date('2026-10-01T00:00:00Z'),
        notes: 'Resina en 36',
        performedById: authorId,
        diagnoses: {
          create: [
            { icd10Code: 'K02.1', kind: 'PRINCIPAL', position: 0 },
            {
              icd10Code: 'K05.1',
              kind: 'RELACIONADO',
              toothFdi: '36',
              position: 1,
            },
          ],
        },
      },
      include: { diagnoses: { orderBy: { position: 'asc' } } },
    });
    return {
      tenantId,
      patientId: patient.id,
      otherPatientId: other.id,
      entryId: entry.id,
      diagnosisId: entry.diagnoses[0].id,
    };
  });
}

async function cleanup(tenantIds: string[]): Promise<void> {
  const where = { tenantId: { in: tenantIds } };
  // Superusuario: el trigger deja la purga administrativa.
  await raw.clinicalEntryDiagnosis.deleteMany({ where });
  await raw.clinicalEntry.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

const SUBDOMAINS = ['dx212-int-a', 'dx212-int-b'];
const AUTHOR_EMAIL = 'dx212-int-autor@example.com';

/** Restos de una corrida anterior interrumpida. */
async function purgeLeftovers(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  await cleanup(tenants.map((t) => t.id));
  await raw.user.deleteMany({ where: { email: AUTHOR_EMAIL } });
}

describe('diagnósticos CIE-10 de la evolución (DX-212, int)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await seedIcd10Codes(raw);
    await purgeLeftovers();
    authorId = (
      await raw.user.create({
        data: {
          email: AUTHOR_EMAIL,
          passwordHash: 'x',
          fullName: 'Dra. Autora',
        },
      })
    ).id;
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
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

  /** SQL directo como dentalix_app con el tenant de A fijado. */
  function asAppRole(sql: string, ...params: unknown[]) {
    return appRole.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
      return tx.$executeRawUnsafe(sql, ...params);
    });
  }

  it('DX-236: copia el texto de referencia y conserva la copia tras un cambio del owner', async () => {
    await raw.icd10Code.update({
      where: { code: 'K02.1' },
      data: { labelEs: 'Etiqueta de referencia posterior' },
    });
    try {
      const [snapshot] = await raw.$queryRaw<{ labelEs: string }[]>`
        SELECT "labelEs" FROM clinical_entry_diagnoses WHERE id = ${a.diagnosisId}::uuid`;
      expect(snapshot.labelEs).toBe('Caries de la dentina');
      await seedIcd10Codes(raw);
      expect(
        (await raw.icd10Code.findUniqueOrThrow({ where: { code: 'K02.1' } }))
          .labelEs,
      ).toBe('Etiqueta de referencia posterior');
    } finally {
      await raw.icd10Code.update({
        where: { code: 'K02.1' },
        data: { labelEs: 'Caries de la dentina' },
      });
    }
  });

  it('DX-236: la BD ignora una etiqueta proporcionada por el cliente al insertar', async () => {
    const [saved] = await asA(async (tx) => {
      const entry = await tx.clinicalEntry.create({
        data: {
          tenantId: a.tenantId,
          patientId: a.patientId,
          notes: 'Snapshot seguro',
          entryDate: new Date('2026-10-21T00:00:00Z'),
          performedById: authorId,
        },
      });
      return tx.$queryRaw<{ labelEs: string }[]>`
        INSERT INTO clinical_entry_diagnoses (id, "tenantId", "patientId", "clinicalEntryId", "icd10Code", kind, position, "labelEs")
        VALUES (gen_random_uuid(), ${a.tenantId}::uuid, ${a.patientId}::uuid, ${entry.id}::uuid, 'K02.1', 'PRINCIPAL', 0, 'Texto falsificado')
        RETURNING "labelEs"`;
    });
    expect(saved.labelEs).toBe('Caries de la dentina');
  });

  describe('inalterable (DX-038)', () => {
    it('DX-236: rechaza el UPDATE de la nueva etiqueta como app', async () => {
      await expect(
        asAppRole(
          `UPDATE clinical_entry_diagnoses SET "labelEs" = 'Falsificado' WHERE id = $1::uuid`,
          a.diagnosisId,
        ),
      ).rejects.toThrow(IMMUTABLE);
    });
    it('rechaza el UPDATE como rol de la app', async () => {
      await expect(
        asAppRole(
          `UPDATE "clinical_entry_diagnoses" SET "icd10Code" = 'K02.0' WHERE "id" = $1::uuid`,
          a.diagnosisId,
        ),
      ).rejects.toThrow(IMMUTABLE);
    });

    it('rechaza el DELETE como rol de la app', async () => {
      await expect(
        asAppRole(
          `DELETE FROM "clinical_entry_diagnoses" WHERE "id" = $1::uuid`,
          a.diagnosisId,
        ),
      ).rejects.toThrow(IMMUTABLE);
    });

    it('rechaza el DELETE aunque una tabla temporal suplante pg_roles (search_path fijo, SEC-032)', async () => {
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
            `DELETE FROM "clinical_entry_diagnoses" WHERE "id" = $1::uuid`,
            a.diagnosisId,
          );
        }),
      ).rejects.toThrow(IMMUTABLE);
    });

    it('rechaza el UPDATE incluso al superusuario', async () => {
      await expect(
        raw.$executeRawUnsafe(
          `UPDATE "clinical_entry_diagnoses" SET "toothFdi" = '46' WHERE "id" = $1::uuid`,
          a.diagnosisId,
        ),
      ).rejects.toThrow(IMMUTABLE);
    });

    it('no deja añadir un diagnóstico a una evolución ya guardada (solo junto con ella)', async () => {
      await expect(
        asA((tx) =>
          tx.clinicalEntryDiagnosis.create({
            data: {
              tenantId: a.tenantId,
              patientId: a.patientId,
              clinicalEntryId: a.entryId,
              icd10Code: 'K04.0',
              kind: 'RELACIONADO',
              position: 2,
            },
          }),
        ),
      ).rejects.toThrow(/junto con su evolución/);
    });

    it('con la evolución entra aunque la sesión no esté en UTC (hora del servidor en UTC, DX-226)', async () => {
      const entryId = await asA(async (tx) => {
        await tx.$executeRaw`SET LOCAL TIME ZONE 'America/Bogota'`;
        const entry = await tx.clinicalEntry.create({
          data: {
            tenantId: a.tenantId,
            patientId: a.otherPatientId,
            entryDate: new Date('2026-10-02T00:00:00Z'),
            notes: 'Control con sesión en Bogotá',
            performedById: authorId,
            diagnoses: {
              create: [{ icd10Code: 'K02.1', kind: 'PRINCIPAL', position: 0 }],
            },
          },
        });
        return entry.id;
      });
      const count = await raw.clinicalEntryDiagnosis.count({
        where: { clinicalEntryId: entryId },
      });
      expect(count).toBe(1);
    });

    it('las funciones de los triggers fijan search_path con pg_temp al final', async () => {
      const rows = await raw.$queryRaw<{ name: string; config: string[] }[]>`
        SELECT p.proname AS name, p.proconfig AS config
          FROM pg_trigger t
          JOIN pg_proc p ON p.oid = t.tgfoid
         WHERE t.tgrelid = 'public.clinical_entry_diagnoses'::regclass
           AND NOT t.tgisinternal`;
      expect(rows.length).toBeGreaterThanOrEqual(4);
      for (const row of rows) {
        expect(row.config).toContain('search_path=pg_catalog, pg_temp');
      }
    });
  });

  describe('reglas en la BD', () => {
    /** Evolución nueva con los diagnósticos dados, en una transacción. */
    function entryWith(
      diagnoses: Prisma.ClinicalEntryDiagnosisUncheckedCreateWithoutEntryInput[],
    ) {
      return asA((tx) =>
        tx.clinicalEntry.create({
          data: {
            tenantId: a.tenantId,
            patientId: a.patientId,
            entryDate: new Date('2026-10-02T00:00:00Z'),
            notes: 'Control',
            performedById: authorId,
            diagnoses: { create: diagnoses },
          },
        }),
      );
    }

    it('un segundo PRINCIPAL choca con el CHECK de posición y el único por evolución', async () => {
      await expect(
        entryWith([
          {
            icd10Code: 'K02.1',
            kind: 'PRINCIPAL',
            position: 0,
          },
          {
            icd10Code: 'K05.1',
            kind: 'PRINCIPAL',
            position: 1,
          },
        ]),
      ).rejects.toThrow(/clinical_entry_diagnoses_position_kind/);
      await expect(
        entryWith([
          {
            icd10Code: 'K02.1',
            kind: 'PRINCIPAL',
            position: 0,
          },
          {
            icd10Code: 'K05.1',
            kind: 'PRINCIPAL',
            position: 0,
          },
        ]),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('un cuarto relacionado (posición 4) no entra', async () => {
      await expect(
        entryWith([
          {
            icd10Code: 'K02.1',
            kind: 'PRINCIPAL',
            position: 0,
          },
          {
            icd10Code: 'K05.1',
            kind: 'RELACIONADO',
            position: 4,
          },
        ]),
      ).rejects.toThrow(/clinical_entry_diagnoses_position_kind/);
    });

    it('diente no FDI y código inexistente fallan', async () => {
      await expect(
        entryWith([
          {
            icd10Code: 'K02.1',
            kind: 'PRINCIPAL',
            position: 0,
            toothFdi: '19',
          },
        ]),
      ).rejects.toThrow(/clinical_entry_diagnoses_tooth_fdi/);
      await expect(
        entryWith([
          {
            icd10Code: 'K99.9',
            kind: 'PRINCIPAL',
            position: 0,
          },
        ]),
      ).rejects.toThrow();
    });
  });

  describe('aislamiento por clínica (RLS FORCE + FK compuestas)', () => {
    it('RLS ENABLE y FORCE en la tabla', async () => {
      const [row] = await raw.$queryRaw<{ rls: boolean; force: boolean }[]>`
        SELECT relrowsecurity AS rls, relforcerowsecurity AS force
          FROM pg_class WHERE oid = 'public.clinical_entry_diagnoses'::regclass`;
      expect(row).toEqual({ rls: true, force: true });
    });

    it('la clínica B no ve los diagnósticos de A', async () => {
      const seen = await prisma.runWithTenant(b.tenantId, (tx) =>
        tx.clinicalEntryDiagnosis.findMany({
          where: { clinicalEntryId: a.entryId },
        }),
      );
      expect(seen).toEqual([]);
      const own = await asA((tx) =>
        tx.clinicalEntryDiagnosis.count({
          where: { clinicalEntryId: a.entryId },
        }),
      );
      expect(own).toBe(2);
    });

    it('con el tenant de una clínica sin datos, el rol de la app no ve ninguno', async () => {
      const seen = await appRole.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${'00000000-0000-4000-8000-000000000000'}, true)`;
        return tx.clinicalEntryDiagnosis.count();
      });
      expect(seen).toBe(0);
    });

    it('la FK compuesta impide colgar el diagnóstico de la evolución de OTRO paciente', async () => {
      // El trigger «junto con su evolución» ya lo rechazaría antes; se apaga
      // DENTRO de la transacción (se deshace con ella) para probar la FK sola.
      await expect(
        raw.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'ALTER TABLE "clinical_entry_diagnoses" DISABLE TRIGGER "clinical_entry_diagnoses_with_entry"',
          );
          return tx.clinicalEntryDiagnosis.create({
            data: {
              tenantId: a.tenantId,
              patientId: a.otherPatientId,
              clinicalEntryId: a.entryId,
              icd10Code: 'K02.1',
              kind: 'PRINCIPAL',
              position: 0,
            },
          });
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('…y de la evolución de OTRA clínica', async () => {
      await expect(
        raw.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'ALTER TABLE "clinical_entry_diagnoses" DISABLE TRIGGER "clinical_entry_diagnoses_with_entry"',
          );
          return tx.clinicalEntryDiagnosis.create({
            data: {
              tenantId: b.tenantId,
              patientId: a.patientId,
              clinicalEntryId: a.entryId,
              icd10Code: 'K02.1',
              kind: 'PRINCIPAL',
              position: 0,
            },
          });
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('no se puede escribir un diagnóstico con el tenant de otra clínica (WITH CHECK)', async () => {
      await expect(
        asA(async (tx) => {
          const entry = await tx.clinicalEntry.create({
            data: {
              tenantId: a.tenantId,
              patientId: a.patientId,
              entryDate: new Date('2026-10-04T00:00:00Z'),
              notes: 'Cruce',
              performedById: authorId,
            },
          });
          return tx.clinicalEntryDiagnosis.create({
            data: {
              tenantId: b.tenantId,
              patientId: a.patientId,
              clinicalEntryId: entry.id,
              icd10Code: 'K02.1',
              kind: 'PRINCIPAL',
              position: 0,
            },
          });
        }),
      ).rejects.toThrow();
    });
  });

  describe('tabla CIE-10 (referencia global)', () => {
    it('la siembra es idempotente: dos pasadas dejan los mismos códigos', async () => {
      await seedIcd10Codes(raw);
      await seedIcd10Codes(raw);
      const codes = ICD10_ORAL_CODES.map((c) => c.code);
      const rows = await raw.icd10Code.findMany({
        where: { code: { in: codes } },
      });
      expect(rows).toHaveLength(codes.length);
      expect(new Set(codes).size).toBe(codes.length);
      expect(rows.find((r) => r.code === 'K02.1')?.labelEs).toBe(
        'Caries de la dentina',
      );
      expect(codes).toContain('Z01.2');
      expect(codes.every((c) => /^(K(0\d|1[0-4])\.\d|Z01\.2)$/.test(c))).toBe(
        true,
      );
    });

    it('no tiene tenant ni RLS, y el rol de la app la lee', async () => {
      const [row] = await raw.$queryRaw<{ rls: boolean }[]>`
        SELECT relrowsecurity AS rls FROM pg_class
         WHERE oid = 'public.icd10_codes'::regclass`;
      expect(row.rls).toBe(false);
      expect(await appRole.icd10Code.count()).toBeGreaterThanOrEqual(
        ICD10_ORAL_CODES.length,
      );
    });

    it('un código con diagnósticos no se puede borrar (RESTRICT)', async () => {
      await expect(
        raw.icd10Code.delete({ where: { code: 'K02.1' } }),
      ).rejects.toThrow();
    });
  });
});
