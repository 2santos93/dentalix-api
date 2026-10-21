import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  adminUrlFor,
  ownerUrlFor,
  requireOwnerNosuEnv,
} from './owner-nosu-env';

// DX-251 (OPS-037): `prisma migrate deploy` aplica todas las migraciones en UNA
// sesión. Un backfill que fija la clínica con `set_config(…, true)` (DX-225)
// deja `app.current_tenant` en '' al terminar su transacción, no en NULL. La
// migración siguiente que valida una FK hacia una tabla con FORCE (DX-151:
// patient_documents → patients) lanza la consulta de validación como el
// owner, con su RLS: con `''::uuid` la política reventaba con 22P02 en cuanto
// `patients` tenía filas, y el despliegue quedaba a medias (P3018).
//
// Aquí se reproduce ese estado de sesión sin depender del orden de las
// migraciones: base migrada desde cero por el owner sin superusuario, una
// clínica con un paciente (cargado como admin) y, en una sola sesión psql del
// owner: set_config local → la variable queda '' → leer `patients` y volver a
// añadir (validando) la FK de patient_documents. Con las políticas tolerantes
// (NULLIF) las dos cosas pasan, y el owner sigue sin ver ninguna fila.

const ROOT = join(__dirname, '..', '..');
const T_A = '00000000-0000-4000-8000-0000002510a1';

describe('DX-251 · app.current_tenant vacío en la sesión de migrate deploy (owner-nosu, OPS-037)', () => {
  const env = requireOwnerNosuEnv();
  const db = `dx251_guc_${process.pid}_${Date.now()}`;
  const admin = new PrismaClient({
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
    target = new PrismaClient({
      datasources: { db: { url: adminUrlFor(env, db) } },
    });
    await target.$executeRawUnsafe(
      `INSERT INTO "tenants" ("id","name","subdomain","updatedAt")
       VALUES ('${T_A}','Clínica GUC','dx251-guc',now())`,
    );
    await target.$executeRawUnsafe(
      `INSERT INTO "patients" ("id","tenantId","firstName","lastName","updatedAt")
       VALUES (gen_random_uuid(),'${T_A}','Pía','Arias',now())`,
    );
  }, 300_000);

  afterAll(async () => {
    await target?.$disconnect();
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`,
    );
    await admin.$disconnect();
  });

  it('tras un set_config local, la sesión del owner lee patients sin 22P02 y sin ver filas', () => {
    const r = ownerSession(
      `SELECT pg_catalog.set_config('app.current_tenant', '${T_A}', true)`,
      `SELECT 'vacia=' || (current_setting('app.current_tenant', true) = '')`,
      `SELECT 'pacientes=' || count(*) FROM public."patients"`,
    );
    expect(r.out).not.toMatch(/invalid input syntax for type uuid/);
    expect(r.status).toBe(0);
    expect(r.out).toContain('vacia=true');
    // Tolerante, no abierta: el owner sin clínica no ve el paciente.
    expect(r.out).toContain('pacientes=0');
  });

  it('en esa misma sesión, la FK de patient_documents hacia patients (FORCE) se valida (lo que rompió DX-151)', async () => {
    const r = ownerSession(
      `SELECT pg_catalog.set_config('app.current_tenant', '${T_A}', true)`,
      `DO $$
       DECLARE k record;
       BEGIN
         FOR k IN SELECT c.conname, pg_get_constraintdef(c.oid) AS def
                    FROM pg_constraint c
                   WHERE c.conrelid = 'public.patient_documents'::regclass
                     AND c.confrelid = 'public.patients'::regclass
                     AND c.contype = 'f'
         LOOP
           EXECUTE format('ALTER TABLE public.patient_documents DROP CONSTRAINT %I', k.conname);
           EXECUTE format('ALTER TABLE public.patient_documents ADD CONSTRAINT %I %s', k.conname, k.def);
         END LOOP;
       END $$`,
    );
    expect(r.out).not.toMatch(/invalid input syntax for type uuid/);
    expect(r.status).toBe(0);
    const fks = await target.$queryRaw<{ convalidated: boolean }[]>`
      SELECT convalidated FROM pg_constraint
       WHERE conrelid = 'public.patient_documents'::regclass
         AND confrelid = 'public.patients'::regclass AND contype = 'f'`;
    expect(fks.length).toBeGreaterThan(0);
    expect(fks.every((k) => k.convalidated)).toBe(true);
  });
});
