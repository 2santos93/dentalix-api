import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  adminUrlFor,
  ownerUrlFor,
  requireOwnerNosuEnv,
} from './owner-nosu-env';

// SEC-042: el trigger `payments_void_immutable` rechaza cualquier UPDATE o
// DELETE de un abono anulado y el alta de uno ya anulado, también para el owner
// de las migraciones SIN superusuario ni BYPASSRLS (Postgres gestionado): la
// guarda no depende de ser superusuario (`dx_cash_is_superuser()` lee pg_roles
// con el rol de quien escribe) y la anulación de un abono vigente sigue
// pasando. La migración se aplica con `prisma migrate deploy` desde cero por
// ese owner.

const ROOT = join(__dirname, '..', '..');
const T_A = '00000000-0000-4000-8000-0000004420a1';
const L_A = '00000000-0000-4000-8000-0000004420a2';
const P_A = '00000000-0000-4000-8000-0000004420a3';
const PLAN = '00000000-0000-4000-8000-0000004420a4';
const VOIDED = '00000000-0000-4000-8000-0000004420a5';
const LIVE = '00000000-0000-4000-8000-0000004420a6';

describe('SEC-042 · el abono anulado es inmutable bajo el owner sin superusuario', () => {
  const env = requireOwnerNosuEnv();
  const db = `sec042_void_${process.pid}_${Date.now()}`;
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: adminUrlFor(env, 'postgres') } },
  });
  let target: PrismaClient;

  /** Varias sentencias del owner en UNA sesión psql; cada -c es su transacción. */
  function ownerSession(...statements: string[]): {
    status: number | null;
    out: string;
  } {
    const u = new URL(ownerUrlFor(env, db));
    u.search = '';
    const r = spawnSync(
      'psql',
      [
        u.toString(),
        '-X',
        '-tA',
        '-v',
        'ON_ERROR_STOP=1',
        ...statements.flatMap((s) => ['-c', s]),
      ],
      { encoding: 'utf8' },
    );
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  /** La clínica fijada para la sesión (no local) y después la sentencia. */
  const withClinic = (sql: string): string[] => [
    `SELECT pg_catalog.set_config('app.current_tenant', '${T_A}', false)`,
    sql,
  ];

  beforeAll(async () => {
    const [role] = await admin.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${env.owner}`;
    // Si el owner saltara la RLS, este spec no probaría nada.
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    await admin.$executeRawUnsafe(
      `CREATE DATABASE "${db}" OWNER "${env.owner}"`,
    );
    execFileSync(
      join(ROOT, 'node_modules/.bin/prisma'),
      ['migrate', 'deploy'],
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
    target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: adminUrlFor(env, db) } },
    });
    // Como admin (salta la RLS): un abono anulado y otro vigente.
    for (const sql of [
      `INSERT INTO "tenants" ("id","name","subdomain","updatedAt")
         VALUES ('${T_A}','Clínica SEC-042','sec042-owner',now())`,
      `INSERT INTO "locations" ("id","tenantId","name","countryCode","updatedAt")
         VALUES ('${L_A}','${T_A}','Sede','VE',now())`,
      `INSERT INTO "patients" ("id","tenantId","firstName","lastName","updatedAt")
         VALUES ('${P_A}','${T_A}','Ana','Anulado',now())`,
      `INSERT INTO "treatment_plans" ("id","tenantId","patientId","status","currency","updatedAt")
         VALUES ('${PLAN}','${T_A}','${P_A}','ACCEPTED','VES',now())`,
      `INSERT INTO "payments" ("id","tenantId","locationId","treatmentPlanId","patientId","amount","currency","paidAt","updatedAt")
         VALUES ('${LIVE}','${T_A}','${L_A}','${PLAN}','${P_A}',100,'VES',now(),now())`,
      `INSERT INTO "payments" ("id","tenantId","locationId","treatmentPlanId","patientId","amount","currency","paidAt","updatedAt","deletedAt","voidedAt")
         VALUES ('${VOIDED}','${T_A}','${L_A}','${PLAN}','${P_A}',100,'VES',now(),now(),now(),now())`,
    ]) {
      await target.$executeRawUnsafe(sql);
    }
  }, 300_000);

  afterAll(async () => {
    await target?.$disconnect();
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`,
    );
    await admin.$disconnect();
  });

  it('el owner no edita ni borra un abono anulado, con error en español', () => {
    for (const sql of [
      `UPDATE public."payments" SET "notes" = "notes" WHERE "id" = '${VOIDED}'`,
      `DELETE FROM public."payments" WHERE "id" = '${VOIDED}'`,
    ]) {
      const r = ownerSession(...withClinic(sql));
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/abono anulado es definitivo/);
    }
  });

  it('el owner no inserta un abono que nace anulado', () => {
    const r = ownerSession(
      ...withClinic(
        `INSERT INTO public."payments" ("id","tenantId","locationId","treatmentPlanId","patientId","amount","currency","paidAt","updatedAt","deletedAt","voidedAt")
         VALUES (gen_random_uuid(),'${T_A}','${L_A}','${PLAN}','${P_A}',1,'VES',now(),now(),now(),now())`,
      ),
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/ya como abono anulado/);
  });

  it('el owner sí anula un abono vigente', () => {
    const r = ownerSession(
      ...withClinic(
        `UPDATE public."payments" SET "deletedAt" = now(), "voidedAt" = now() WHERE "id" = '${LIVE}'`,
      ),
    );
    expect(r.status).toBe(0);
    expect(r.out).toContain('UPDATE 1');
  });
});
