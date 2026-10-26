import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  adminUrlFor,
  ownerUrlFor,
  requireOwnerNosuEnv,
} from './owner-nosu-env';

// DX-051: la liberación de imputaciones (triggers de treatment_plan_items y
// treatment_plans) borra o reduce filas de payment_allocations, que tiene RLS
// FORCE. Un owner sin superusuario ni BYPASSRLS que cambie el precio de un
// ítem sin `app.current_tenant` (p. ej. una migración con datos que quita
// FORCE a las tablas que toca pero no a payment_allocations) no vería las
// imputaciones: la liberación borraría 0 filas en silencio y el ítem quedaría
// «cobrado» por encima de su precio. La guarda de tenant lo convierte en un
// error. Con la clínica fijada, la misma sentencia libera lo que sobra.

const ROOT = join(__dirname, '..', '..');
const T_A = '00000000-0000-4000-8000-0000000051a1';
const GUARD = 'Falta el tenant de la sesión (DX-051)';

describe('DX-051 · liberación de imputaciones sin el tenant de la sesión (owner-nosu)', () => {
  const env = requireOwnerNosuEnv();
  const db = `dx051_alloc_${process.pid}_${Date.now()}`;
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: adminUrlFor(env, 'postgres') } },
  });
  let target: PrismaClient;
  let itemId: string;
  let paymentId: string;

  /** Un script del owner en UNA sesión psql y UNA transacción. */
  function ownerTransaction(sql: string): {
    status: number | null;
    out: string;
  } {
    const u = new URL(ownerUrlFor(env, db));
    u.search = '';
    const r = spawnSync(
      'psql',
      [u.toString(), '-X', '-tA', '-v', 'ON_ERROR_STOP=1', '-1', '-c', sql],
      { encoding: 'utf8' },
    );
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  const allocated = async () =>
    Number(
      (
        await target.paymentAllocation.findFirstOrThrow({
          where: { paymentId, treatmentPlanItemId: itemId },
        })
      ).amount,
    );

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
    // El admin (superusuario) carga las filas saltando la RLS.
    target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: adminUrlFor(env, db) } },
    });
    await target.tenant.create({
      data: { id: T_A, name: 'Clínica imputación', subdomain: 'dx051-nosu' },
    });
    const location = await target.location.create({
      data: { tenantId: T_A, name: 'Sede' },
    });
    const patient = await target.patient.create({
      data: { tenantId: T_A, firstName: 'Pía', lastName: 'Arias' },
    });
    const catalog = await target.dentalCatalogItem.create({
      data: {
        tenantId: T_A,
        code: 'dx051-nosu',
        kind: 'PROCEDURE',
        labelEs: 'Resina',
        color: '#123456',
      },
    });
    const plan = await target.treatmentPlan.create({
      data: {
        tenantId: T_A,
        patientId: patient.id,
        currency: 'EUR',
        status: 'ACCEPTED',
      },
    });
    itemId = (
      await target.treatmentPlanItem.create({
        data: {
          tenantId: T_A,
          planId: plan.id,
          toothNumber: '11',
          catalogItemId: catalog.id,
          price: 100,
          status: 'ACCEPTED',
        },
      })
    ).id;
    paymentId = (
      await target.payment.create({
        data: {
          tenantId: T_A,
          locationId: location.id,
          treatmentPlanId: plan.id,
          patientId: patient.id,
          amount: 100,
          currency: 'EUR',
          paidAt: new Date('2026-10-20T12:00:00.000Z'),
        },
      })
    ).id;
    await target.paymentPlanAmount.create({
      data: {
        paymentId,
        tenantId: T_A,
        treatmentPlanId: plan.id,
        amount: 100,
        currency: 'EUR',
        rateDate: new Date('2026-10-20T00:00:00.000Z'),
      },
    });
    await target.paymentAllocation.create({
      data: {
        tenantId: T_A,
        paymentId,
        treatmentPlanId: plan.id,
        treatmentPlanItemId: itemId,
        amount: 100,
        source: 'AUTO',
      },
    });
  }, 300_000);

  afterAll(async () => {
    await target?.$disconnect();
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`,
    );
    await admin.$disconnect();
  });

  it('release without the tenant GUC raises instead of deleting nothing', async () => {
    // Como una migración con datos: NO FORCE en las tablas que toca (y en las
    // que leen sus triggers), no en payment_allocations; sin clínica fijada.
    const r = ownerTransaction(`
      DO $$
      DECLARE t record;
      BEGIN
        FOR t IN SELECT c.relname FROM pg_class c
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relforcerowsecurity
                   AND c.relname <> 'payment_allocations'
        LOOP
          EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t.relname);
        END LOOP;
      END $$;
      UPDATE public."treatment_plan_items" SET "price" = 50 WHERE "id" = '${itemId}';
    `);
    expect(r.out).toContain(GUARD);
    expect(r.status).not.toBe(0);
    // Nada cambió: ni el precio ni la imputación (la transacción se deshizo).
    expect(
      Number(
        (
          await target.treatmentPlanItem.findUniqueOrThrow({
            where: { id: itemId },
          })
        ).price,
      ),
    ).toBe(100);
    expect(await allocated()).toBe(100);
  });

  it('with the clinic set, the same update releases the excess', async () => {
    const r = ownerTransaction(`
      SELECT pg_catalog.set_config('app.current_tenant', '${T_A}', true);
      UPDATE public."treatment_plan_items" SET "price" = 50 WHERE "id" = '${itemId}';
    `);
    expect(r.out).not.toContain(GUARD);
    expect(r.status).toBe(0);
    expect(await allocated()).toBe(50);
  });
});
