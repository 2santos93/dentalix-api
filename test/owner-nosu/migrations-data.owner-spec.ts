import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  adminUrlFor,
  ownerUrlFor,
  requireOwnerNosuEnv,
} from './owner-nosu-env';

// DX-113: las migraciones de datos no pierden filas en silencio cuando el
// owner NO es superusuario ni tiene BYPASSRLS (Postgres gestionado). Con RLS
// FORCE ese owner está sujeto a la RLS: sin `app.current_tenant` un UPDATE o
// un INSERT … SELECT verían 0 filas y la migración "pasaría" sin hacer nada.
//
// Una BD desechable, propiedad del owner de DIRECT_URL, recibe las
// migraciones por tramos con `prisma migrate deploy` (la herramienta real).
// Antes de cada migración de datos se cargan filas (como admin, saltando la
// RLS) y después se comprueba:
//   - que ninguna tabla tiene menos filas que antes (salvo las que la propia
//     migración retira a propósito), y
//   - que la migración hizo su trabajo sobre esas filas (el backfill está).
// Al final, FORCE sigue activo en toda tabla con RLS y todo es del owner.
//
// Corre en el job «Migraciones con owner sin superusuario» de la CI (ver
// README, «Despliegue: roles de la BD»), no en `test:int`: necesita un rol
// owner sin superusuario y un admin que cree bases.

const ROOT = join(__dirname, '..', '..');

/** psql no acepta el `?schema=public` de las URL de Prisma. */
const psqlUrl = (url: string): string => {
  const u = new URL(url);
  u.search = '';
  return u.toString();
};
const MIGRATIONS = join(ROOT, 'prisma/migrations');

const T_A = '00000000-0000-4000-8000-0000000000a1';
const T_B = '00000000-0000-4000-8000-0000000000b1';
const U_A = '00000000-0000-4000-8000-0000000000a2';
const U_B = '00000000-0000-4000-8000-0000000000b2';
const P_A = '00000000-0000-4000-8000-0000000000a3';
const P_B = '00000000-0000-4000-8000-0000000000b3';
const TP_A = '00000000-0000-4000-8000-0000000000a4';
const TP_B = '00000000-0000-4000-8000-0000000000b4';

/**
 * Esquema de 20260731000000 (antes de la primera migración de datos con
 * filas de clínica): dos clínicas con lo que leen las migraciones de datos.
 * Las fechas son fijas para poder comprobar los backfills.
 */
const FIXTURE_INITIAL = [
  `INSERT INTO "tenants" ("id","name","subdomain","updatedAt") VALUES
     ('${T_A}','Clínica A','mig-a',now()), ('${T_B}','Clínica B','mig-b',now())`,
  `INSERT INTO "users" ("id","email","passwordHash","fullName","updatedAt") VALUES
     ('${U_A}','a@mig.test','x','Ana A',now()), ('${U_B}','b@mig.test','x','Beto B',now())`,
  // OWNER: 20260731170000_remove_owner_role lo pasa a ADMIN.
  `INSERT INTO "clinic_memberships" ("id","tenantId","userId","role","updatedAt") VALUES
     (gen_random_uuid(),'${T_A}','${U_A}','OWNER',now()),
     (gen_random_uuid(),'${T_B}','${U_B}','DENTIST',now())`,
  `INSERT INTO "patients" ("id","tenantId","firstName","lastName","updatedAt") VALUES
     ('${P_A}','${T_A}','Pía','Arias','2026-01-15 10:00'),
     ('${P_B}','${T_B}','Pablo','Bernal','2026-01-15 10:00')`,
  // Texto libre: 20260731120000_structured_clinical_history lo guarda en notes
  // antes de borrar las columnas viejas.
  `INSERT INTO "medical_history_versions" ("id","tenantId","patientId","version","allergies","habits","notes") VALUES
     (gen_random_uuid(),'${T_A}','${P_A}',1,'Penicilina',NULL,'Control anual'),
     (gen_random_uuid(),'${T_B}','${P_B}',1,NULL,'Fuma',NULL)`,
  `INSERT INTO "treatment_plans" ("id","tenantId","patientId","status","currency","updatedAt") VALUES
     ('${TP_A}','${T_A}','${P_A}','ACCEPTED','COP',now()),
     ('${TP_B}','${T_B}','${P_B}','ACCEPTED','COP',now())`,
  // paidAt a medianoche UTC: 20261017113000_payments_civil_day_noon los pasa
  // al mediodía civil. El anulado (deletedAt): 20261016160000 copia voidedAt.
  `INSERT INTO "payments" ("id","tenantId","treatmentPlanId","patientId","amount","currency","paidAt","method","updatedAt","deletedAt") VALUES
     (gen_random_uuid(),'${T_A}','${TP_A}','${P_A}',50000,'COP','2026-03-01 00:00','CASH',now(),NULL),
     (gen_random_uuid(),'${T_A}','${TP_A}','${P_A}',20000,'COP','2026-03-02 00:00','CARD',now(),'2026-03-03 09:30'),
     (gen_random_uuid(),'${T_B}','${TP_B}','${P_B}',80000,'COP','2026-03-05 15:45','TRANSFER',now(),NULL)`,
  // Atenciones: 20261017170000_dx039_clinical_record_retention calcula la última.
  `INSERT INTO "appointments" ("id","tenantId","patientId","providerId","start","end","status","updatedAt") VALUES
     (gen_random_uuid(),'${T_A}','${P_A}','${U_A}','2026-03-10 14:00','2026-03-10 14:30','COMPLETED',now()),
     (gen_random_uuid(),'${T_B}','${P_B}','${U_B}','2026-02-10 14:00','2026-02-10 14:30','CANCELLED',now())`,
  `INSERT INTO "clinical_entries" ("id","tenantId","patientId","entryDate","notes") VALUES
     (gen_random_uuid(),'${T_B}','${P_B}','2026-04-01 16:00','Profilaxis')`,
];

/** Esquema de 20261016160001: consentimiento del booleano legado. */
const FIXTURE_CONSENTS = [
  `UPDATE "patients" SET "dataConsentAccepted" = true,
          "dataConsentAt" = '2026-02-01 12:00', "dataConsentPolicyVersion" = 'v1'
    WHERE "id" = '${P_A}'`,
];

/** Esquema de 20261017113000: eventos que la partición tiene que conservar. */
const FIXTURE_AUDIT = [
  `INSERT INTO "audit_events"
     ("id","tenantId","actorUserId","actorRole","action","resourceType",
      "patientId","requestId","occurredAt","metadata")
   SELECT gen_random_uuid(),
          CASE WHEN g % 2 = 0 THEN '${T_A}'::uuid ELSE '${T_B}'::uuid END,
          '${U_A}', 'ADMIN', 'VIEW', 'PATIENT', '${P_A}', 'req-' || g,
          date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(days => g * 13),
          jsonb_build_object('n', g)
     FROM generate_series(1, 40) AS g`,
];

const U_C = '00000000-0000-4000-8000-0000000000c2';

/**
 * Esquema de 20261017231000 (DX-143): U_B (DENTIST, no dueña) inició sesión;
 * U_C no hizo nada. U_A es la dueña registrada con su clínica (FIXTURE_INITIAL).
 */
const FIXTURE_LOGINS = [
  `INSERT INTO "users" ("id","email","passwordHash","fullName","createdAt","updatedAt") VALUES
     ('${U_C}','c@mig.test','x','Ceci C','2025-01-01 00:00',now())`,
  `INSERT INTO "audit_events"
     ("id","tenantId","actorUserId","actorRole","action","resourceType","occurredAt")
   VALUES
     (gen_random_uuid(),'${T_B}','${U_B}','DENTIST','LOGIN','SESSION','2026-05-01 10:00'),
     (gen_random_uuid(),'${T_B}','${U_B}','DENTIST','LOGIN','SESSION','2026-06-01 10:00'),
     (gen_random_uuid(),'${T_B}','${U_C}','DENTIST','LOGIN_FAILED','SESSION','2026-06-01 10:00')`,
];

/**
 * Esquema de 20261017233200 (DX-136): más sedes, con nombres que chocan, para
 * el relleno de la serie de recibos ("receiptPrefix") por orden de alta.
 */
// Después de la "Sede principal" de cada clínica, que add_locations creó con now().
const FIXTURE_LOCATIONS = [
  `INSERT INTO "locations" ("id","tenantId","name","createdAt","updatedAt") VALUES
     (gen_random_uuid(),'${T_A}','Sede Norte',now() + interval '1 day',now()),
     (gen_random_uuid(),'${T_A}','Sede Nórte',now() + interval '2 days',now()),
     (gen_random_uuid(),'${T_B}','Sede Norte',now() + interval '1 day',now())`,
];

/**
 * Esquema de 20261017233300 (DX-128): un móvil escrito a mano, el que usa el
 * botón wa.me manual; la migración no lo toca.
 */
const FIXTURE_CONTACT = [
  `UPDATE "patients" SET "phone" = '310 555 0101' WHERE "id" = '${P_A}'`,
];

interface Step {
  /** Se aplican todas las migraciones con nombre < `until`. */
  until: string;
  /** Filas a cargar ANTES del tramo (como admin). */
  fixture?: string[];
  /** Tablas que el tramo retira o vacía a propósito (no cuentan como pérdida). */
  dropped?: string[];
}

const STEPS: Step[] = [
  { until: '20260731115959', fixture: [] },
  // 20260731120000_structured_clinical_history y _remove_owner_role.
  { until: '20260801150000', fixture: FIXTURE_INITIAL },
  // 20260801150000_add_locations: ver el test de abajo.
  { until: '20260801150001' },
  // tenant_composite_fks, domain_checks, currency_fks, payment_void_audit.
  { until: '20261016170000' },
  // data_processing_consents (editada: FORCE fuera durante la copia).
  { until: '20261017113000', fixture: FIXTURE_CONSENTS },
  // payments_civil_day_noon (editada: FORCE fuera durante el backfill).
  { until: '20261017130000', fixture: FIXTURE_AUDIT },
  // audit_events_partitioned (DX-102) y dx039_clinical_record_retention.
  { until: '20261017231100', dropped: ['audit_events_dx009'] },
  // dx143_verify_active_accounts (FORCE fuera de audit_events y
  // clinic_memberships durante el backfill), dx144 y dx145.
  { until: '20261017233000', fixture: FIXTURE_LOGINS },
  // dx155_patient_ledgers (FORCE fuera de las tablas que lee y escribe
  // durante el backfill).
  { until: '20261017233050' },
  // dx136_receipt_enums, dx136_audit_events_receipt_idx y
  // dx136_payment_receipts (FORCE fuera de locations durante el relleno).
  { until: '20261017233300', fixture: FIXTURE_LOCATIONS },
  // dx128_contact_channel (FORCE fuera de patients durante el backfill del
  // canal por defecto de la clínica).
  { until: '99999999999999', fixture: FIXTURE_CONTACT },
];

describe('DX-113 · migraciones de datos con un owner sin superusuario (owner-nosu)', () => {
  const env = requireOwnerNosuEnv();
  const db = `dx113_mig_${process.pid}_${Date.now()}`;
  const dir = mkdtempSync(join(tmpdir(), 'dx113-'));
  const admin = new PrismaClient({
    datasources: { db: { url: adminUrlFor(env, 'postgres') } },
  });
  let target: PrismaClient;
  let applied = new Set<string>();

  /** Prisma CLI como el owner; si falla, el error lleva su salida. */
  function prisma(args: string[]): void {
    try {
      execFileSync(
        join(ROOT, 'node_modules/.bin/prisma'),
        [...args, '--schema', join(dir, 'schema.prisma')],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            DATABASE_URL: ownerUrlFor(env, db),
            DIRECT_URL: ownerUrlFor(env, db),
          },
          stdio: 'pipe',
        },
      );
    } catch (err) {
      const { stdout, stderr } = err as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(
        `prisma ${args.join(' ')} falló:\n${String(stdout ?? '')}${String(stderr ?? '')}`,
      );
    }
  }

  function deploy(until: string): void {
    for (const name of readdirSync(MIGRATIONS)) {
      if (name.endsWith('.toml') || name >= until || applied.has(name)) {
        continue;
      }
      cpSync(join(MIGRATIONS, name), join(dir, 'migrations', name), {
        recursive: true,
      });
    }
    prisma(['migrate', 'deploy']);
    applied = new Set(readdirSync(join(dir, 'migrations')));
  }

  /** Filas por tabla de public (vistas por el admin, sin RLS). */
  async function counts(): Promise<Record<string, number>> {
    const rows = await target.$queryRaw<{ table: string; n: number }[]>`
      SELECT c.relname AS table,
             (xpath('/row/n/text()', query_to_xml(
                format('SELECT count(*) AS n FROM public.%I', c.relname),
                false, true, '')))[1]::text::int AS n
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         AND NOT c.relispartition AND c.relname <> '_prisma_migrations'`;
    return Object.fromEntries(rows.map((r) => [r.table, r.n]));
  }

  async function run(step: Step): Promise<void> {
    for (const sql of step.fixture ?? []) {
      await target.$executeRawUnsafe(sql);
    }
    const before = await counts();
    deploy(step.until);
    const after = await counts();
    const lost = Object.entries(before)
      .filter(([t]) => !(step.dropped ?? []).includes(t))
      .filter(([t, n]) => (after[t] ?? 0) < n)
      .map(([t, n]) => `${t}: ${n} → ${after[t] ?? 'sin tabla'}`);
    expect(lost).toEqual([]);
  }

  async function scalar<T>(sql: string): Promise<T> {
    const rows = await target.$queryRawUnsafe<{ v: T }[]>(sql);
    return rows[0]?.v;
  }

  beforeAll(async () => {
    const [role] = await admin.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${env.owner}`;
    // Si el owner saltara la RLS, este spec no probaría nada.
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    await admin.$executeRawUnsafe(
      `CREATE DATABASE "${db}" OWNER "${env.owner}"`,
    );
    cpSync(join(ROOT, 'prisma/schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(
      join(MIGRATIONS, 'migration_lock.toml'),
      join(dir, 'migrations', 'migration_lock.toml'),
    );
    target = new PrismaClient({
      datasources: { db: { url: adminUrlFor(env, db) } },
    });
  });

  afterAll(async () => {
    await target?.$disconnect();
    await admin.$executeRawUnsafe(`ALTER ROLE "${env.owner}" NOBYPASSRLS`);
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`,
    );
    await admin.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('historia clínica estructurada y rol OWNER: el texto libre pasa a notes y OWNER a ADMIN', async () => {
    await run(STEPS[0]);
    await run(STEPS[1]);
    expect(
      await scalar<string>(
        `SELECT string_agg("notes", ' | ' ORDER BY "tenantId") AS v FROM "medical_history_versions"`,
      ),
    ).toBe('Control anual\n[Alergias] Penicilina | [Hábitos] Fuma');
    expect(
      await scalar<string>(
        `SELECT string_agg("role"::text, ',' ORDER BY "tenantId") AS v FROM "clinic_memberships"`,
      ),
    ).toBe('ADMIN,DENTIST');
  }, 180_000);

  it('add_locations con clínicas previas falla de forma RUIDOSA y sin tocar nada (no hay pérdida silenciosa)', async () => {
    // Inserta la sede por defecto en una tabla recién creada con FORCE: con
    // este owner la WITH CHECK de la política la rechaza. Solo puede pasar en
    // una BD con datos migrada así; un despliegue nuevo la aplica vacía.
    const before = await counts();
    expect(() => deploy('20260801150001')).toThrow(
      /row-level security policy for table "locations"/,
    );
    expect(await counts()).toEqual(before);
    // Recuperación documentada (README): repetirla una vez con BYPASSRLS
    // temporal. Aquí sirve para seguir probando las migraciones siguientes.
    prisma([
      'migrate',
      'resolve',
      '--rolled-back',
      '20260801150000_add_locations',
    ]);
    await admin.$executeRawUnsafe(`ALTER ROLE "${env.owner}" BYPASSRLS`);
    try {
      await run(STEPS[2]);
    } finally {
      await admin.$executeRawUnsafe(`ALTER ROLE "${env.owner}" NOBYPASSRLS`);
    }
    expect(
      await scalar<number>(
        `SELECT count(*)::int AS v FROM "appointments" WHERE "locationId" IS NULL`,
      ),
    ).toBe(0);
  }, 180_000);

  it('FK compuestas, reglas de dominio y anulaciones: pasan y el abono anulado conserva su fecha de anulación', async () => {
    await run(STEPS[3]);
    expect(
      await scalar<string>(
        `SELECT to_char("voidedAt", 'YYYY-MM-DD HH24:MI') AS v FROM "payments" WHERE "deletedAt" IS NOT NULL`,
      ),
    ).toBe('2026-03-03 09:30');
  }, 180_000);

  it('consentimientos: el booleano legado pasa a una fila LEGACY', async () => {
    await run(STEPS[4]);
    expect(
      await scalar<string>(
        `SELECT string_agg("patientId"::text || ':' || "granted" || ':' || "channel", ',') AS v
           FROM "data_processing_consents"`,
      ),
    ).toBe(`${P_A}:true:LEGACY`);
  }, 180_000);

  it('día civil de los abonos: las medianoches UTC pasan al mediodía de Bogotá y quedan registradas', async () => {
    await run(STEPS[5]);
    expect(
      await scalar<string>(
        `SELECT string_agg(to_char("paidAt", 'MM-DD HH24:MI'), ',' ORDER BY "paidAt") AS v FROM "payments"`,
      ),
    ).toBe('03-01 17:00,03-02 17:00,03-05 15:45');
    expect(
      await scalar<number>(
        `SELECT count(*)::int AS v FROM "payments_paidat_backfill_dx097"`,
      ),
    ).toBe(2);
  }, 180_000);

  it('auditoría particionada y retención: se conservan los eventos y se calcula la última atención', async () => {
    const events = await scalar<number>(
      `SELECT count(*)::int AS v FROM "audit_events"`,
    );
    expect(events).toBe(40);
    await run(STEPS[6]);
    expect(
      await scalar<number>(`SELECT count(*)::int AS v FROM "audit_events"`),
    ).toBe(events);
    expect(
      await scalar<string>(
        `SELECT string_agg(to_char("last_attention_at", 'YYYY-MM-DD HH24:MI'), ',' ORDER BY "tenantId") AS v FROM "patients"`,
      ),
    ).toBe('2026-03-10 14:00,2026-04-01 16:00');
  }, 180_000);

  it('emailVerifiedAt (DX-143): verifica a quien inició sesión y a la dueña del registro, no al resto, y es idempotente', async () => {
    await run(STEPS[7]);
    const verified = (): Promise<string> =>
      scalar<string>(
        `SELECT string_agg("email" || ':' || coalesce(to_char("emailVerifiedAt", 'YYYY-MM-DD HH24:MI'), '-'), ',' ORDER BY "email") AS v FROM "users"`,
      );
    const createdA = await scalar<string>(
      `SELECT to_char("createdAt", 'YYYY-MM-DD HH24:MI') AS v FROM "users" WHERE "id" = '${U_A}'`,
    );
    const expected = `a@mig.test:${createdA},b@mig.test:2026-05-01 10:00,c@mig.test:-`;
    expect(await verified()).toBe(expected);
    // Idempotente: repetirla (como hace el owner al reintentar) no cambia nada.
    const sql = readFileSync(
      join(
        MIGRATIONS,
        '20261017231100_dx143_verify_active_accounts/migration.sql',
      ),
      'utf8',
    );
    execFileSync(
      'psql',
      [
        psqlUrl(ownerUrlFor(env, db)),
        '-X',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
        '-1',
        '-c',
        sql,
      ],
      {
        stdio: 'pipe',
      },
    );
    expect(await verified()).toBe(expected);
  }, 180_000);

  it('resumen de la cartera (DX-155): el backfill ve las filas de las dos clínicas', async () => {
    await run(STEPS[8]);
    // A: abonó 50.000 vivos (el de 20.000 está anulado) a un plan sin ítems,
    // atendido en su sede; B: abonó 80.000, sin citas atendidas (la sede es
    // la del abono). Ninguno debe (facturable 0).
    expect(
      await scalar<string>(
        `SELECT string_agg("patientId"::text || ':' || "owing" || ':' ||
                           ("ledger" -> 'plans' -> 0 ->> 6) || ':' ||
                           ("locationId" IS NOT NULL), ',' ORDER BY "tenantId") AS v
           FROM "patient_ledgers"`,
      ),
    ).toBe(`${P_A}:false:50000.00:true,${P_B}:false:80000.00:true`);
  }, 180_000);

  it('serie de recibos (DX-136): cada sede previa recibe la suya, desambiguada dentro de su clínica', async () => {
    await run(STEPS[9]);
    expect(
      await scalar<string>(
        `SELECT string_agg("tenantId"::text || ':' || "receiptPrefix", ',' ORDER BY "tenantId", "createdAt") AS v
           FROM "locations"`,
      ),
    ).toBe(`${T_A}:PRI,${T_A}:NOR,${T_A}:NOR2,${T_B}:PRI,${T_B}:NOR`);
  }, 180_000);

  it('canal de contacto (DX-128): los pacientes quedan con el canal de su clínica, sin opt-in ni baja, y el móvil intacto', async () => {
    const events = await scalar<number>(
      `SELECT count(*)::int AS v FROM "audit_events"`,
    );
    await run(STEPS[10]);
    expect(
      await scalar<string>(
        `SELECT string_agg("contactChannel"::text || ':' || coalesce("phone", '-') || ':' ||
                (("whatsappOptInAt" IS NULL) AND ("reminderOptOutAt" IS NULL))::text,
                ',' ORDER BY "tenantId") AS v FROM "patients"`,
      ),
    ).toBe('EMAIL:310 555 0101:true,EMAIL:-:true');
    expect(
      await scalar<number>(`SELECT count(*)::int AS v FROM "audit_events"`),
    ).toBe(events);
    expect(
      await scalar<boolean>(
        `SELECT convalidated AS v FROM pg_constraint
          WHERE conname = 'audit_events_actor_check'
            AND conrelid = 'public.audit_events'::regclass`,
      ),
    ).toBe(true);
  }, 180_000);

  it('al terminar: FORCE en toda tabla con RLS y todo es del owner', async () => {
    const rows = await target.$queryRaw<
      { table: string; force: boolean; owner: string }[]
    >`
      SELECT c.relname AS table, c.relforcerowsecurity AS force,
             pg_get_userbyid(c.relowner) AS owner
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         AND (c.relrowsecurity OR pg_get_userbyid(c.relowner) <> ${env.owner})`;
    expect(
      rows
        .filter((r) => !r.force || r.owner !== env.owner)
        .map((r) => `${r.table} (force=${r.force}, owner=${r.owner})`),
    ).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(50);
  });
});
