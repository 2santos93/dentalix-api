import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  computePrescriptionHash,
  type PrescriptionHashInput,
} from '../src/modules/prescriptions/domain/prescription-hash';
import { PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS } from '../src/modules/prescriptions/domain/prescription-settings';

// DX-324: la receta deja de razonar por país. Una BD desechable recibe todas
// las migraciones ANTERIORES, clínicas con sedes como las de hoy (el país de
// la sede decidía la receta) y dos recetas legadas; se aplican las cuatro
// migraciones y se comprueba:
//   - que cada clínica conserva lo que la app le hacía, contado con sus
//     sedes vivas (relleno);
//   - los defaults y CHECK de las columnas nuevas;
//   - que las recetas legadas siguen validando su hash y su regla de país,
//     y que la receta única tiene sus propios CHECK e inmutabilidad;
//   - que FORCE vuelve a `locations` y que cada migración toca una tabla.
// Excepción R14: este test siembra filas CO/ES, como el relleno que prueba.

const DX324 = '20261028180000_dx324_membership_specialty';
const SPECIALTY = '20261028180000_dx324_membership_specialty';
const SINGLE_FORMAT = '20261028180100_dx324_prescription_single_format';
const COLUMN = '20261028180300_dx324_tenant_prescription_settings';
const BACKFILL = '20261028180400_dx324_tenant_prescription_settings_backfill';
const ROOT = join(__dirname, '..');

const PLATFORM_DEFAULTS = PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS;

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

const T_CO = '00000000-0000-4000-8000-0000000324a1';
const T_ES = '00000000-0000-4000-8000-0000000324b1';
const T_MIX = '00000000-0000-4000-8000-0000000324c1';
const T_RET = '00000000-0000-4000-8000-0000000324d1';
const T_GONE = '00000000-0000-4000-8000-0000000324e1';
const T_NONE = '00000000-0000-4000-8000-0000000324f1';
const L_CO = '00000000-0000-4000-8000-0000000324a2';
const L_ES = '00000000-0000-4000-8000-0000000324b2';
const P_CO = '00000000-0000-4000-8000-0000000324a3';
const P_ES = '00000000-0000-4000-8000-0000000324b3';
const U_DR = '00000000-0000-4000-8000-000000032401';
const RX_CO = '00000000-0000-4000-8000-0000000324a4';
const RX_ES = '00000000-0000-4000-8000-0000000324b4';
const MEMBERSHIP = '00000000-0000-4000-8000-0000000324a7';

const location = (
  tenant: string,
  name: string,
  country: 'CO' | 'ES',
  retired = false,
  id = 'gen_random_uuid()',
): string =>
  `(${id}, '${tenant}', '${name}', '${country}', 'EUR',
    'Europe/Berlin', 'de-DE', 'h23', ${retired ? 'now()' : 'NULL'}, now())`;

/** Contenido sellado de una receta legada (v2), tal como la emitía la app. */
function legacyContent(
  country: 'CO' | 'ES',
  patientId: string,
): PrescriptionHashInput {
  return {
    country,
    issuedAt: new Date('2026-10-20T15:00:00.000Z'),
    dispensationDate: '2026-10-20',
    validUntil: country === 'CO' ? '2026-11-18' : '2026-10-29',
    patientId,
    patientName: `Paciente ${country}`,
    patientDocument: country === 'ES' ? '12345678Z' : null,
    patientBirthYear: country === 'ES' ? 1980 : null,
    clinicalRecordNumber: country === 'CO' ? '123' : null,
    professionalId: U_DR,
    professionalName: 'Dra. Prueba',
    professionalLicense: 'RM-1',
    professionalEmail: null,
    clinicName: `Clínica ${country}`,
    locationName: 'Sede 1',
    locationAddress: null,
    notes: null,
    allergyOverride: false,
    allergyMatches: [],
    safetyRulesVersion: '2026-10-24',
    safetyAlerts: [],
    safetyOverrideReason: null,
    items: [
      {
        position: 1,
        activeIngredient: 'Amoxicilina',
        brandName: null,
        concentration: '500 mg',
        pharmaceuticalForm: 'Cápsula',
        route: 'Oral',
        dose: '1 cápsula',
        frequency: 'Cada 8 horas',
        durationDays: 7,
        totalQuantity: 21,
        quantityUnit: 'cápsulas',
        quantityInWords: 'veintiuno',
        packages: country === 'ES' ? 1 : null,
        instructions: null,
      },
    ],
  };
}

const lit = (v: string | number | boolean | null): string =>
  v === null
    ? 'NULL'
    : typeof v === 'string'
      ? `'${v.replace(/'/g, "''")}'`
      : String(v);

/** INSERT de la receta y su medicamento en una sentencia (misma transacción). */
function legacyInsert(
  id: string,
  tenant: string,
  locationId: string,
  c: PrescriptionHashInput,
): string {
  const [item] = c.items;
  return `WITH rx AS (
    INSERT INTO "prescriptions" ("id","tenantId","locationId","patientId","professionalId",
      "country","issuedAt","dispensationDate","validUntil","patientName","patientDocument",
      "patientBirthYear","clinicalRecordNumber","professionalName","professionalLicense",
      "professionalEmail","clinicName","locationName","locationAddress","notes",
      "allergyOverride","allergyMatches","safetyRulesVersion","safetyAlerts",
      "safetyOverrideReason","contentHash")
    VALUES ('${id}','${tenant}','${locationId}','${c.patientId}','${c.professionalId}',
      '${c.country}','${c.issuedAt.toISOString()}','${c.dispensationDate}','${c.validUntil}',
      ${lit(c.patientName)},${lit(c.patientDocument)},${lit(c.patientBirthYear)},
      ${lit(c.clinicalRecordNumber)},${lit(c.professionalName)},${lit(c.professionalLicense)},
      ${lit(c.professionalEmail)},${lit(c.clinicName)},${lit(c.locationName)},
      ${lit(c.locationAddress)},${lit(c.notes)},${c.allergyOverride},'[]'::jsonb,
      ${lit(c.safetyRulesVersion)},'[]'::jsonb,${lit(c.safetyOverrideReason)},
      '${computePrescriptionHash(c)}')
    RETURNING "id", "tenantId")
  INSERT INTO "prescription_items" ("id","tenantId","prescriptionId","position",
    "activeIngredient","brandName","concentration","pharmaceuticalForm","route","dose",
    "frequency","durationDays","totalQuantity","quantityUnit","quantityInWords",
    "packages","instructions")
  SELECT gen_random_uuid(), rx."tenantId", rx."id", ${item.position},
    ${lit(item.activeIngredient)},${lit(item.brandName)},${lit(item.concentration)},
    ${lit(item.pharmaceuticalForm)},${lit(item.route)},${lit(item.dose)},
    ${lit(item.frequency)},${item.durationDays},${item.totalQuantity},
    ${lit(item.quantityUnit)},${lit(item.quantityInWords)},${lit(item.packages)},
    ${lit(item.instructions)}
    FROM rx`;
}

// Clínicas como las deja DX-316, antes de DX-324.
const SEED = [
  `INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt")
   VALUES ('${T_CO}', 'Clínica CO', 'dx324-co', now()),
          ('${T_ES}', 'Clínica ES', 'dx324-es', now()),
          ('${T_MIX}', 'Clínica mixta', 'dx324-mix', now()),
          ('${T_RET}', 'Clínica con sede retirada', 'dx324-ret', now()),
          ('${T_GONE}', 'Clínica sin sedes vivas', 'dx324-gone', now()),
          ('${T_NONE}', 'Clínica sin sedes', 'dx324-none', now())`,
  `INSERT INTO "locations" ("id", "tenantId", "name", "country", "currency",
                            "timeZone", "locale", "hourCycle", "deletedAt",
                            "updatedAt")
   VALUES ${[
     location(T_CO, 'Sede 1', 'CO', false, `'${L_CO}'`),
     location(T_CO, 'Sede 2', 'CO'),
     location(T_ES, 'Sede 1', 'ES', false, `'${L_ES}'`),
     location(T_MIX, 'Sede 1', 'CO'),
     location(T_MIX, 'Sede 2', 'ES'),
     location(T_RET, 'Sede viva', 'CO'),
     location(T_RET, 'Sede cerrada', 'ES', true),
     location(T_GONE, 'Sede cerrada', 'CO', true),
   ].join(',\n')}`,
  `INSERT INTO "users" ("id","email","passwordHash","fullName","updatedAt")
   VALUES ('${U_DR}','dr@dx324.test','x','Dra. Prueba',now())`,
  `INSERT INTO "clinic_memberships" ("id","tenantId","userId","role","updatedAt")
   VALUES ('${MEMBERSHIP}','${T_CO}','${U_DR}','DENTIST',now())`,
  `INSERT INTO "patients" ("id","tenantId","firstName","lastName","updatedAt")
   VALUES ('${P_CO}','${T_CO}','Paciente','CO',now()),
          ('${P_ES}','${T_ES}','Paciente','ES',now())`,
  legacyInsert(RX_CO, T_CO, L_CO, legacyContent('CO', P_CO)),
  legacyInsert(RX_ES, T_ES, L_ES, legacyContent('ES', P_ES)),
];

/** El SQL de una migración sin sus comentarios. */
function migrationSql(name: string): string {
  return readFileSync(
    join(ROOT, 'prisma/migrations', name, 'migration.sql'),
    'utf8',
  )
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

/** Tablas que el SQL altera con ALTER TABLE. */
function alteredTables(sql: string): string[] {
  return [...sql.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?"?(\w+)"?/gi)].map(
    (m) => m[1],
  );
}

describe('DX-324 · migraciones de la receta única y sus ajustes por clínica (int)', () => {
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  let db: string;
  let dir: string;
  let target: PrismaClient;

  beforeAll(async () => {
    db = `dx324_mig_${process.pid}_${Date.now()}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    dir = mkdtempSync(join(tmpdir(), 'dx324-'));
    cpSync(join(ROOT, 'prisma/schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(
      join(ROOT, 'prisma/migrations/migration_lock.toml'),
      join(dir, 'migrations/migration_lock.toml'),
    );
    const copy = (name: string): void =>
      cpSync(
        join(ROOT, 'prisma/migrations', name),
        join(dir, 'migrations', name),
        { recursive: true },
      );
    const all = readdirSync(join(ROOT, 'prisma/migrations')).filter(
      (name) => !name.endsWith('.toml'),
    );
    for (const name of all.filter((n) => n < DX324)) copy(name);
    migrateDeploy(dir, urlFor(db));
    target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: urlFor(db) } },
    });
    for (const sql of SEED) await target.$executeRawUnsafe(sql);
    for (const name of all.filter((n) => n >= DX324)) copy(name);
    migrateDeploy(dir, urlFor(db));
  }, 240_000);

  afterAll(async () => {
    await target?.$disconnect();
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`,
    );
    rmSync(dir, { recursive: true, force: true });
    await admin.$disconnect();
  }, 60_000);

  async function settings(tenant: string): Promise<string> {
    const [row] = await target.$queryRaw<{ v: string }[]>`
      SELECT "prescriptionPrintQuantityInWords" || '/'
             || "prescriptionRequireClinicalRecordNumber" || '/'
             || "prescriptionValidityDays" AS v
        FROM "tenants" WHERE "id" = ${tenant}::uuid`;
    return row.v;
  }

  /** Una receta con los valores de una legada CO, más `over` (SQL literal). */
  function insertRx(over: Record<string, string>): Promise<number> {
    const row: Record<string, string> = {
      id: 'gen_random_uuid()',
      tenantId: `'${T_CO}'`,
      locationId: `'${L_CO}'`,
      patientId: `'${P_CO}'`,
      professionalId: `'${U_DR}'`,
      country: `'CO'`,
      issuedAt: 'now()',
      dispensationDate: `'2026-10-28'`,
      validUntil: `'2026-11-26'`,
      patientName: `'Paciente CO'`,
      clinicalRecordNumber: `'123'`,
      professionalName: `'Dra. Prueba'`,
      professionalLicense: `'RM-1'`,
      clinicName: `'Clínica CO'`,
      locationName: `'Sede 1'`,
      safetyRulesVersion: `'2026-10-24'`,
      safetyAlerts: `'[]'::jsonb`,
      contentHash: `'${'c'.repeat(64)}'`,
      ...over,
    };
    return target.$executeRawUnsafe(
      `INSERT INTO "prescriptions" (${Object.keys(row)
        .map((k) => `"${k}"`)
        .join(',')}) VALUES (${Object.values(row).join(',')})`,
    );
  }

  /** Receta única válida, más `over`. */
  const single = (over: Record<string, string> = {}) =>
    insertRx({
      singleFormat: 'true',
      printQuantityInWords: 'false',
      clinicalRecordNumber: 'NULL',
      ...over,
    });

  it('backfill uses live locations only', async () => {
    expect({
      co: await settings(T_CO),
      es: await settings(T_ES),
      mixed: await settings(T_MIX),
      retired: await settings(T_RET),
      gone: await settings(T_GONE),
      none: await settings(T_NONE),
    }).toEqual({
      co: 'true/true/30',
      es: 'true/true/10',
      mixed: 'true/true/10',
      retired: 'true/true/30',
      gone: 'false/false/30',
      none: 'false/false/30',
    });
  });

  it('a clinic with only ES locations keeps requiring the patient document', async () => {
    // Hoy la rama ES exige el documento (como DNI/NIE): la clínica lo sigue
    // exigiendo; solo cambian el formato y la etiqueta.
    const [row] = await target.$queryRaw<{ hc: boolean }[]>`
      SELECT "prescriptionRequireClinicalRecordNumber" AS hc
        FROM "tenants" WHERE "id" = ${T_ES}::uuid`;
    expect(row.hc).toBe(true);
  });

  it('migration defaults equal PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS', async () => {
    const rows = await target.$queryRaw<
      { column: string; nullable: string; columnDefault: string | null }[]
    >`
      SELECT column_name AS column, is_nullable AS nullable,
             column_default AS "columnDefault"
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'tenants'
         AND column_name LIKE 'prescription%'
       ORDER BY column_name`;
    expect(rows).toEqual([
      {
        column: 'prescriptionPrintQuantityInWords',
        nullable: 'NO',
        columnDefault: String(PLATFORM_DEFAULTS.printQuantityInWords),
      },
      {
        column: 'prescriptionRequireClinicalRecordNumber',
        nullable: 'NO',
        columnDefault: String(PLATFORM_DEFAULTS.requireClinicalRecordNumber),
      },
      {
        column: 'prescriptionValidityDays',
        nullable: 'NO',
        columnDefault: String(PLATFORM_DEFAULTS.validityDays),
      },
    ]);
  });

  it('CHECK rejects validity 0 and 366 and accepts 1 and 365', async () => {
    const set = (value: number) =>
      target.$executeRawUnsafe(
        `UPDATE "tenants" SET "prescriptionValidityDays" = ${value} WHERE "id" = '${T_NONE}'`,
      );
    await expect(set(0)).rejects.toThrow(
      /tenants_prescription_validity_days_check/,
    );
    await expect(set(366)).rejects.toThrow(
      /tenants_prescription_validity_days_check/,
    );
    try {
      await expect(set(1)).resolves.toBe(1);
      await expect(set(365)).resolves.toBe(1);
    } finally {
      await set(PLATFORM_DEFAULTS.validityDays);
    }
  });

  it('a tenant INSERT that does not name the settings gets false, false and 30', async () => {
    // Lo que envía el cliente Prisma de una réplica anterior a DX-324.
    const [row] = await target.$queryRaw<
      { words: boolean; hc: boolean; days: number }[]
    >`
      INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt")
      VALUES (gen_random_uuid(), 'Réplica antigua', 'dx324-old', now())
      RETURNING "prescriptionPrintQuantityInWords" AS words,
                "prescriptionRequireClinicalRecordNumber" AS hc,
                "prescriptionValidityDays" AS days`;
    expect(row).toEqual({
      words: PLATFORM_DEFAULTS.printQuantityInWords,
      hc: PLATFORM_DEFAULTS.requireClinicalRecordNumber,
      days: PLATFORM_DEFAULTS.validityDays,
    });
  });

  it('a prescription INSERT that does not name singleFormat is legacy (false)', async () => {
    const id = '00000000-0000-4000-8000-0000000324a5';
    await insertRx({ id: `'${id}'` });
    const [row] = await target.$queryRaw<
      { singleFormat: boolean; printQuantityInWords: boolean | null }[]
    >`
      SELECT "singleFormat", "printQuantityInWords"
        FROM "prescriptions" WHERE "id" = ${id}::uuid`;
    expect(row).toEqual({ singleFormat: false, printQuantityInWords: null });
  });

  it('legacy CO and ES rows read back with integrityOk true after the migrations', async () => {
    const rows = await target.prescription.findMany({
      where: { id: { in: [RX_CO, RX_ES] } },
      include: { items: true },
      orderBy: { country: 'asc' },
    });
    expect(rows.map((r) => r.country)).toEqual(['CO', 'ES']);
    for (const row of rows) {
      expect({
        singleFormat: row.singleFormat,
        printQuantityInWords: row.printQuantityInWords,
        professionalSpecialty: row.professionalSpecialty,
        patientAgeYears: row.patientAgeYears,
        patientWeightKg: row.patientWeightKg,
      }).toEqual({
        singleFormat: false,
        printQuantityInWords: null,
        professionalSpecialty: null,
        patientAgeYears: null,
        patientWeightKg: null,
      });
      // Lo que hace GetPrescriptionUseCase: recalcula el hash con la fila leída.
      const readBack: PrescriptionHashInput = {
        country: row.country,
        issuedAt: row.issuedAt,
        dispensationDate: row.dispensationDate.toISOString().slice(0, 10),
        validUntil: row.validUntil.toISOString().slice(0, 10),
        patientId: row.patientId,
        patientName: row.patientName,
        patientDocument: row.patientDocument,
        patientBirthYear: row.patientBirthYear,
        clinicalRecordNumber: row.clinicalRecordNumber,
        professionalId: row.professionalId,
        professionalName: row.professionalName,
        professionalLicense: row.professionalLicense,
        professionalEmail: row.professionalEmail,
        clinicName: row.clinicName,
        locationName: row.locationName,
        locationAddress: row.locationAddress,
        notes: row.notes,
        allergyOverride: row.allergyOverride,
        allergyMatches: [],
        safetyRulesVersion: row.safetyRulesVersion,
        safetyAlerts: [],
        safetyOverrideReason: row.safetyOverrideReason,
        items: row.items.map(
          ({ id: _id, tenantId: _t, prescriptionId: _p, ...item }) => item,
        ),
      };
      expect(computePrescriptionHash(readBack)).toBe(row.contentHash);
      expect(row.contentHash).toBe(
        computePrescriptionHash(
          legacyContent(row.country, row.country === 'CO' ? P_CO : P_ES),
        ),
      );
    }
  });

  it('legacy CHECK applies only to legacy rows', async () => {
    await expect(
      insertRx({ singleFormat: 'false', clinicalRecordNumber: 'NULL' }),
    ).rejects.toThrow(/prescriptions_legacy_country_fields_check/);
    await expect(
      insertRx({
        singleFormat: 'true',
        printQuantityInWords: 'false',
        clinicalRecordNumber: 'NULL',
      }),
    ).resolves.toBe(1);
  });

  it('single format checks', async () => {
    const CHECK = /prescriptions_single_format_check/;
    await expect(single({ printQuantityInWords: 'NULL' })).rejects.toThrow(
      CHECK,
    );
    await expect(
      insertRx({ singleFormat: 'false', printQuantityInWords: 'true' }),
    ).rejects.toThrow(CHECK);
    await expect(single({ professionalSpecialty: `''` })).rejects.toThrow(
      CHECK,
    );
    await expect(single({ patientAgeYears: '151' })).rejects.toThrow(CHECK);
    await expect(single({ patientAgeYears: '-1' })).rejects.toThrow(CHECK);
    await expect(single({ patientAgeYears: '0' })).resolves.toBe(1);
    await expect(single({ patientAgeYears: '150' })).resolves.toBe(1);
    await expect(
      single({ professionalSpecialty: `'${'x'.repeat(80)}'` }),
    ).resolves.toBe(1);
    await expect(
      single({ professionalSpecialty: `'${'x'.repeat(81)}'` }),
    ).rejects.toThrow(CHECK);
    await expect(single({ patientWeightKg: '0' })).rejects.toThrow(CHECK);
    await expect(single({ patientWeightKg: '400' })).rejects.toThrow(CHECK);
    await expect(single({ patientWeightKg: '72.5' })).resolves.toBe(1);
  });

  it('membership specialty CHECK rejects blank and over 80 characters', async () => {
    const set = (value: string | null) =>
      target.$executeRaw`
        UPDATE "clinic_memberships" SET "professionalSpecialty" = ${value}
         WHERE "id" = ${MEMBERSHIP}::uuid`;
    await expect(set('   ')).rejects.toThrow(
      /clinic_memberships_professional_specialty_check/,
    );
    await expect(set('x'.repeat(81))).rejects.toThrow(
      /clinic_memberships_professional_specialty_check/,
    );
    await expect(set('x'.repeat(80))).resolves.toBe(1);
    await expect(set(null)).resolves.toBe(1);
  });

  it('a single-format row is immutable, including the new columns', async () => {
    const id = '00000000-0000-4000-8000-0000000324a6';
    await single({ id: `'${id}'`, patientWeightKg: '72.5' });
    await expect(
      target.$transaction([
        target.$executeRaw`SELECT set_config('app.current_tenant', ${T_CO}, true)`,
        target.$executeRaw`UPDATE "prescriptions" SET "patientWeightKg" = 1 WHERE "id" = ${id}::uuid`,
      ]),
    ).rejects.toThrow(/solo se puede anular/);
  });

  it('locations is FORCE ROW LEVEL SECURITY again after the backfill', async () => {
    const [row] = await target.$queryRaw<{ forced: boolean }[]>`
      SELECT relforcerowsecurity AS forced FROM pg_class
       WHERE oid = 'public.locations'::regclass`;
    expect(row.forced).toBe(true);
  });

  it('the column migration only alters tenants and the backfill migration does not ALTER tenants', () => {
    // Como DX-328: la migración que toma ACCESS EXCLUSIVE en `tenants` no
    // espera después el de `locations` en la misma transacción.
    expect(alteredTables(migrationSql(COLUMN))).toEqual(['tenants']);
    const backfill = alteredTables(migrationSql(BACKFILL));
    expect(backfill).not.toContain('tenants');
    expect(backfill).toEqual(['locations', 'locations']);
  });

  it('each migration touches one table', () => {
    const tables = (name: string) => [
      ...new Set(alteredTables(migrationSql(name))),
    ];
    expect({
      specialty: tables(SPECIALTY),
      singleFormat: tables(SINGLE_FORMAT),
      settings: tables(COLUMN),
      backfill: tables(BACKFILL),
    }).toEqual({
      specialty: ['clinic_memberships'],
      singleFormat: ['prescriptions'],
      settings: ['tenants'],
      backfill: ['locations'],
    });
    // El relleno solo escribe en `tenants` (UPDATE), sin ALTER.
    expect(migrationSql(BACKFILL)).toMatch(/UPDATE\s+"tenants"/);
  });
});
