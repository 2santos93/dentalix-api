import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  adminUrlFor,
  ownerUrlFor,
  requireOwnerNosuEnv,
} from './owner-nosu-env';

// DX-438 (DB-066): el trigger `treatment_plans_credit_currency_locked` es
// SECURITY INVOKER y busca los asientos bajo la RLS de la sesión. Con el owner
// sin superusuario ni BYPASSRLS (Postgres gestionado), ya sea en un
// mantenimiento a mano o en una migración futura:
//   - con la clínica fijada ve los asientos y rechaza el cambio de moneda
//     (restrict_violation), y deja cambiar otras columnas;
//   - sin clínica no ve ni el plan (FORCE en treatment_plans): el UPDATE
//     afecta a 0 filas, no hay hueco por el que el cambio pase sin la guarda.
// La migración se aplica con `prisma migrate deploy` desde cero por ese owner.

const ROOT = join(__dirname, '..', '..');
const T_A = '00000000-0000-4000-8000-0000004380a1';
const L_A = '00000000-0000-4000-8000-0000004380a2';
const P_A = '00000000-0000-4000-8000-0000004380a3';
const SOURCE = '00000000-0000-4000-8000-0000004380a4';
const TARGET = '00000000-0000-4000-8000-0000004380a5';
const U_A = '00000000-0000-4000-8000-0000004380a6';
const TRANSFER = '00000000-0000-4000-8000-0000004380a7';

describe('DX-438 · el trigger de moneda con saldo a favor bajo el owner sin superusuario', () => {
  const env = requireOwnerNosuEnv();
  const db = `dx438_credit_${process.pid}_${Date.now()}`;
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

  async function planCurrency(id: string): Promise<string> {
    const [row] = await target.$queryRaw<{ currency: string }[]>`
      SELECT "currency" FROM "treatment_plans" WHERE "id" = ${id}::uuid`;
    return row.currency;
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
    // Como admin (salta la RLS): un plan cancelado que traspasó a un borrador.
    for (const sql of [
      `INSERT INTO "tenants" ("id","name","subdomain","updatedAt")
         VALUES ('${T_A}','Clínica DX-438','dx438-owner',now())`,
      `INSERT INTO "users" ("id","email","passwordHash","fullName","updatedAt")
         VALUES ('${U_A}','dx438-owner@example.com','x','Admin',now())`,
      `INSERT INTO "locations" ("id","tenantId","name","countryCode","updatedAt")
         VALUES ('${L_A}','${T_A}','Sede','CO',now())`,
      `INSERT INTO "patients" ("id","tenantId","firstName","lastName","updatedAt")
         VALUES ('${P_A}','${T_A}','Ana','Moneda',now())`,
      `INSERT INTO "treatment_plans" ("id","tenantId","patientId","status","currency","updatedAt")
         VALUES ('${SOURCE}','${T_A}','${P_A}','CANCELLED','COP',now()),
                ('${TARGET}','${T_A}','${P_A}','DRAFT','COP',now())`,
      `INSERT INTO "patient_credit_transfers" ("id","tenantId","locationId","patientId","sourcePlanId","targetPlanId","currency","amount","createdById")
         VALUES ('${TRANSFER}','${T_A}','${L_A}','${P_A}','${SOURCE}','${TARGET}','COP',50000,'${U_A}')`,
      `INSERT INTO "patient_credit_entries" ("id","tenantId","patientId","treatmentPlanId","currency","amount","kind","transferId")
         VALUES (gen_random_uuid(),'${T_A}','${P_A}','${SOURCE}','COP',-50000,'TRANSFER_OUT','${TRANSFER}'),
                (gen_random_uuid(),'${T_A}','${P_A}','${TARGET}','COP',50000,'TRANSFER_IN','${TRANSFER}')`,
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

  it('con la clínica fijada, el owner no cambia la moneda del plan con asientos (restrict_violation)', async () => {
    const r = ownerSession(
      ...withClinic(
        `UPDATE public."treatment_plans" SET "currency" = 'USD' WHERE "id" = '${TARGET}'`,
      ),
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/saldo a favor/);
    expect(await planCurrency(TARGET)).toBe('COP');
  });

  it('con la clínica fijada, sí cambia otras columnas del mismo plan', async () => {
    const r = ownerSession(
      ...withClinic(
        `UPDATE public."treatment_plans" SET "notes" = 'Revisado' WHERE "id" = '${TARGET}'`,
      ),
    );
    expect(r.status).toBe(0);
    expect(r.out).toContain('UPDATE 1');
    const [row] = await target.$queryRaw<{ notes: string | null }[]>`
      SELECT "notes" FROM "treatment_plans" WHERE "id" = ${TARGET}::uuid`;
    expect(row.notes).toBe('Revisado');
  });

  it('sin clínica no ve el plan: 0 filas, la moneda no cambia', async () => {
    const r = ownerSession(
      `UPDATE public."treatment_plans" SET "currency" = 'USD' WHERE "id" = '${TARGET}'`,
    );
    expect(r.status).toBe(0);
    expect(r.out).toContain('UPDATE 0');
    expect(await planCurrency(TARGET)).toBe('COP');
  });
});
