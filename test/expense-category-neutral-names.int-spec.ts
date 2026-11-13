import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-274-bis contra Postgres: las dos predefinidas de gastos con regionalismo
// pasan a términos neutros. El relleno reescribe, clínica a clínica y bajo la
// RLS de cada una, la foto de los gastos (las salidas de caja menor leen la de
// su gasto), retira la propia viva que ya es una predefinida nueva y respeta
// la propia con el nombre anterior. Una segunda pasada no cambia nada. El
// trigger de la migración siguiente hace lo mismo con lo que escriba una
// réplica anterior durante el despliegue.
//
// Este fichero es la única prueba que puede escribir los nombres anteriores
// (excepción de src/architecture/no-regional-expense-categories.spec.ts).

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const MIGRATIONS = join(__dirname, '../prisma/migrations');
const read = (name: string) =>
  readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8');
const BACKFILL = read('20261219090000_dx274b_expense_category_neutral_names');
const ALIAS = read('20261219090100_dx274b_expense_category_legacy_alias');

const SUBDOMAINS = ['dx274b-int-a', 'dx274b-int-b'];
const EMAIL = 'dx274b-int@example.com';
const OLD_RENT = 'Arriendo';
const OLD_CLEANING = 'Aseo y cafetería';

/**
 * Las sentencias de una migración, sin comentarios ni BEGIN/COMMIT (el test
 * la corre dentro de su propia transacción). Los cuerpos `$$ … $$` van
 * enteros aunque lleven `;` (molde de prescription-verification-code).
 */
function statements(sql: string): string[] {
  const parts = sql.replace(/--[^\n]*/g, '').split('$$');
  const out: string[] = [];
  let current = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      current += `$$${part}$$`;
      return;
    }
    const pieces = part.split(';');
    pieces.forEach((piece, j) => {
      current += piece;
      if (j < pieces.length - 1) {
        out.push(current.trim());
        current = '';
      }
    });
  });
  if (current.trim()) out.push(current.trim());
  return out.filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));
}

interface Clinic {
  tenantId: string;
  locationId: string;
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length > 0) {
    const where = { tenantId: { in: ids } };
    // Superusuario: los triggers de no-borrado dejan la purga administrativa.
    await raw.expensePayment.deleteMany({ where });
    await raw.expense.deleteMany({ where });
    await raw.expenseCategory.deleteMany({ where });
    await raw.cashSessionFloat.deleteMany({ where });
    await raw.cashSession.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.tenant.deleteMany({ where: { id: { in: ids } } });
  }
  await raw.user.deleteMany({ where: { email: EMAIL } });
}

describe('DX-274-bis: categorías de gastos neutras — migraciones (Postgres)', () => {
  let a: Clinic;
  let b: Clinic;
  let userId: string;

  async function clinic(subdomain: string): Promise<Clinic> {
    const tenant = await raw.tenant.create({
      data: { name: subdomain, subdomain },
    });
    const location = await raw.location.create({
      data: locationData(REGIONAL_CARACAS_FIXTURE, {
        tenantId: tenant.id,
        name: 'Sede Caracas',
        country: 'VE',
      }),
    });
    return { tenantId: tenant.id, locationId: location.id };
  }

  beforeAll(async () => {
    await cleanup();
    userId = (
      await raw.user.create({
        data: { email: EMAIL, passwordHash: 'x', fullName: 'Rita Recepción' },
      })
    ).id;
    a = await clinic(SUBDOMAINS[0]);
    b = await clinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
  });

  /** Corre `sql` como dentalix_app (sujeto a la RLS, como un owner sin superusuario). */
  async function asApp(
    tx: Prisma.TransactionClient,
    run: () => Promise<void>,
  ): Promise<void> {
    await tx.$executeRawUnsafe('SET LOCAL ROLE dentalix_app');
    await run();
    await tx.$executeRawUnsafe('RESET ROLE');
  }

  it('el relleno reescribe las fotos por clínica, funde la propia «Alquiler», respeta la propia con el nombre anterior, es idempotente y el trigger cubre a las réplicas anteriores', async () => {
    await expect(
      raw.$transaction(
        async (tx) => {
          // Estado anterior a las dos migraciones: sin el trigger ni su función.
          await tx.$executeRawUnsafe(
            'DROP TRIGGER "expenses_category_legacy_alias" ON "expenses"',
          );
          await tx.$executeRawUnsafe(
            'DROP FUNCTION public."dx_expense_category_legacy_alias"()',
          );

          const category = (
            c: Clinic,
            name: string,
            deletedAt: Date | null = null,
          ) =>
            tx.expenseCategory.create({
              data: {
                tenantId: c.tenantId,
                name,
                createdById: userId,
                active: deletedAt === null,
                deletedAt,
              },
            });
          const expense = async (
            c: Clinic,
            name: string,
            extra: Partial<Prisma.ExpenseUncheckedCreateInput> = {},
          ) =>
            (
              await tx.expense.create({
                data: {
                  tenantId: c.tenantId,
                  locationId: c.locationId,
                  category: name,
                  amount: 100,
                  currency: 'USD',
                  invoiceDate: new Date('2026-10-01T00:00:00.000Z'),
                  createdById: userId,
                  updatedAt: new Date('2026-10-02T12:00:00.000Z'),
                  ...extra,
                },
              })
            ).id;

          // Clínica A: la propia «Alquiler» de la demo (DX-335) y otra propia.
          const ownRentA = await category(a, 'Alquiler');
          const ownInsuranceA = await category(a, 'Seguros');
          const rentA = await expense(a, OLD_RENT, {
            supplier: 'Inmobiliaria',
          });
          await tx.expensePayment.create({
            data: {
              tenantId: a.tenantId,
              expenseId: rentA,
              locationId: a.locationId,
              amount: 100,
              currency: 'USD',
              method: 'TRANSFER',
              paidOn: new Date('2026-10-03T00:00:00.000Z'),
              createdById: userId,
            },
          });
          const voidedRentA = await expense(a, 'ARRIENDO');
          await tx.expense.update({
            where: { id: voidedRentA },
            data: {
              voidedAt: new Date(),
              voidedById: userId,
              voidReason: 'Duplicado',
            },
          });
          // Una salida de caja menor: pago con caja de un gasto.
          const session = await tx.cashSession.create({
            data: {
              tenantId: a.tenantId,
              locationId: a.locationId,
              openedById: userId,
            },
          });
          await tx.cashSessionFloat.create({
            data: {
              tenantId: a.tenantId,
              sessionId: session.id,
              currency: 'USD',
              amount: 200,
            },
          });
          const cleaningA = await expense(a, OLD_CLEANING, {
            supplier: 'Abasto',
          });
          await tx.expensePayment.create({
            data: {
              tenantId: a.tenantId,
              expenseId: cleaningA,
              locationId: a.locationId,
              amount: 100,
              currency: 'USD',
              method: 'CASH',
              paidOn: new Date('2026-10-01T00:00:00.000Z'),
              cashSessionId: session.id,
              createdById: userId,
            },
          });
          const ownRentSnapshotA = await expense(a, 'alquiler');
          const exactRentA = await expense(a, 'Alquiler');
          const labA = await expense(a, 'Laboratorio');
          const insuranceA = await expense(a, 'Seguros');

          // Clínica B: una propia «Arriendo» (solo posible por SQL) y una
          // propia «Alquiler» ya retirada.
          const ownOldRentB = await category(b, OLD_RENT);
          const retiredRentB = await category(
            b,
            'Alquiler',
            new Date('2026-09-01T00:00:00.000Z'),
          );
          const rentB = await expense(b, OLD_RENT);
          const cleaningB = await expense(b, 'aseo   y CAFETERIA');

          type Row = { id: string; row: Record<string, unknown> };
          const expenseRows = () =>
            tx.$queryRaw<Row[]>`
              SELECT id::text, to_jsonb(e) - 'category' AS row
                FROM expenses e
               WHERE "tenantId" IN (${a.tenantId}::uuid, ${b.tenantId}::uuid)
               ORDER BY 1`;
          const everything = () =>
            tx.$queryRaw<{ t: string; row: Record<string, unknown> }[]>`
              SELECT 'expenses' AS t, to_jsonb(e) AS row FROM expenses e
               WHERE "tenantId" IN (${a.tenantId}::uuid, ${b.tenantId}::uuid)
              UNION ALL
              SELECT 'expense_categories', to_jsonb(c) FROM expense_categories c
               WHERE "tenantId" IN (${a.tenantId}::uuid, ${b.tenantId}::uuid)
              UNION ALL
              SELECT 'expense_payments', to_jsonb(p) FROM expense_payments p
               WHERE "tenantId" IN (${a.tenantId}::uuid, ${b.tenantId}::uuid)
              ORDER BY 1, 2`;
          const payments = () =>
            tx.$queryRaw<{ row: Record<string, unknown> }[]>`
              SELECT to_jsonb(p) AS row FROM expense_payments p
               WHERE "tenantId" IN (${a.tenantId}::uuid, ${b.tenantId}::uuid)
               ORDER BY id`;
          const categoryOf = async (id: string) =>
            (
              await tx.expense.findUniqueOrThrow({
                where: { id },
                select: { category: true },
              })
            ).category;
          const categoryRow = (id: string) =>
            tx.expenseCategory.findUniqueOrThrow({ where: { id } });

          const otherColumns = await expenseRows();
          const paymentRows = await payments();
          const insuranceRow = await categoryRow(ownInsuranceA.id);
          const ownOldRentRow = await categoryRow(ownOldRentB.id);
          const retiredRentRow = await categoryRow(retiredRentB.id);

          // Como dentalix_app: sin superusuario ni BYPASSRLS la RLS le aplica,
          // igual que a un owner gestionado (DX-113).
          await asApp(tx, async () => {
            for (const statement of statements(BACKFILL))
              await tx.$executeRawUnsafe(statement);
          });

          // Las fotos de A: los nombres anteriores y la grafía distinta, a la
          // nueva exacta; lo demás, igual.
          expect({
            rent: await categoryOf(rentA),
            voided: await categoryOf(voidedRentA),
            outflow: await categoryOf(cleaningA),
            ownSnapshot: await categoryOf(ownRentSnapshotA),
            exact: await categoryOf(exactRentA),
            lab: await categoryOf(labA),
            insurance: await categoryOf(insuranceA),
          }).toEqual({
            rent: 'Alquiler',
            voided: 'Alquiler',
            outflow: 'Limpieza y cafetería',
            ownSnapshot: 'Alquiler',
            exact: 'Alquiler',
            lab: 'Laboratorio',
            insurance: 'Seguros',
          });
          // La salida de caja lee la categoría de su gasto.
          const [outflow] = await tx.$queryRaw<{ category: string }[]>`
            SELECT e."category" FROM expense_payments p
              JOIN expenses e ON e."tenantId" = p."tenantId" AND e."id" = p."expenseId"
             WHERE p."cashSessionId" = ${session.id}::uuid`;
          expect(outflow.category).toBe('Limpieza y cafetería');

          // B: su propia con el nombre anterior manda; el otro sí cambia.
          expect(await categoryOf(rentB)).toBe(OLD_RENT);
          expect(await categoryOf(cleaningB)).toBe('Limpieza y cafetería');

          // La propia «Alquiler» viva de A se retira (se funde con la
          // predefinida): ya no hay una propia viva con ese nombre.
          const merged = await categoryRow(ownRentA.id);
          expect(merged).toMatchObject({ active: false, name: 'Alquiler' });
          expect(merged.deletedAt).not.toBeNull();
          const [{ live }] = await tx.$queryRaw<{ live: number }[]>`
            SELECT count(*)::int AS live FROM expense_categories
             WHERE "tenantId" IN (${a.tenantId}::uuid, ${b.tenantId}::uuid)
               AND "deletedAt" IS NULL
               AND public.dx_search_normalize("name") IN ('alquiler', 'limpieza y cafeteria')`;
          expect(live).toBe(0);
          // Las demás propias, sin tocar (la retirada de B conserva su fecha).
          expect(await categoryRow(ownInsuranceA.id)).toEqual(insuranceRow);
          expect(await categoryRow(ownOldRentB.id)).toEqual(ownOldRentRow);
          expect(await categoryRow(retiredRentB.id)).toEqual(retiredRentRow);

          // Solo cambia "category": ni "updatedAt" ni los pagos.
          expect(await expenseRows()).toEqual(otherColumns);
          expect(await payments()).toEqual(paymentRows);

          // La clínica queda limpia al terminar.
          const [{ tenant }] = await tx.$queryRaw<{ tenant: string | null }[]>`
            SELECT current_setting('app.current_tenant', true) AS tenant`;
          expect(tenant ?? '').toBe('');

          // Idempotente: una segunda pasada no cambia nada.
          const once = await everything();
          await asApp(tx, async () => {
            for (const statement of statements(BACKFILL))
              await tx.$executeRawUnsafe(statement);
          });
          expect(await everything()).toEqual(once);

          // El trigger (migración siguiente): lo que escriba una réplica
          // anterior con el nombre viejo queda con el nuevo; la propia de B,
          // no. Como la app, con la clínica fijada y bajo su RLS.
          for (const statement of statements(ALIAS))
            await tx.$executeRawUnsafe(statement);
          const [trigger] = await tx.$queryRaw<{ tgenabled: string }[]>`
            SELECT tgenabled::text FROM pg_trigger
             WHERE tgname = 'expenses_category_legacy_alias'`;
          expect(trigger.tgenabled).toBe('O');

          let lateA = '';
          let lateB = '';
          await asApp(tx, async () => {
            await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
            lateA = await expense(a, ' arriendo ');
            await tx.expense.update({
              where: { id: labA },
              data: { category: 'ASEO Y CAFETERÍA' },
            });
            await tx.$executeRaw`SELECT set_config('app.current_tenant', ${b.tenantId}, true)`;
            lateB = await expense(b, OLD_RENT);
            await tx.$executeRaw`SELECT set_config('app.current_tenant', '', true)`;
          });
          expect(await categoryOf(lateA)).toBe('Alquiler');
          expect(await categoryOf(labA)).toBe('Limpieza y cafetería');
          expect(await categoryOf(lateB)).toBe(OLD_RENT);
          // Otro texto pasa tal cual.
          await tx.expense.update({
            where: { id: insuranceA },
            data: { category: 'Seguros médicos' },
          });
          expect(await categoryOf(insuranceA)).toBe('Seguros médicos');

          throw new Error('ROLLBACK_QA');
        },
        { timeout: 60_000 },
      ),
    ).rejects.toThrow('ROLLBACK_QA');
  });

  it('el relleno va en BEGIN … COMMIT, clínica a clínica, sin tocar triggers ni FORCE, y solo escribe la categoría y el retiro', () => {
    const body = BACKFILL.replace(/--[^\n]*/g, '');
    const order = [
      /^BEGIN;$/m,
      /SET LOCAL lock_timeout = '5s';/,
      /^DO \$\$$/m,
      /set_config\('app\.current_tenant', t::text, true\)/,
      /set_config\('app\.current_tenant', '', true\)/,
      /^\$\$;$/m,
      /^COMMIT;$/m,
    ].map((re) => body.search(re));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(body).not.toMatch(
      /DISABLE TRIGGER|ENABLE TRIGGER|FORCE ROW LEVEL SECURITY|\bDELETE\b|\bINSERT\b|ALTER TABLE/,
    );
    const sets = [...body.matchAll(/(?:\bSET|,)\s+("\w+")\s*=/g)].map(
      (m) => m[1],
    );
    expect(sets).toEqual([
      '"active"',
      '"deletedAt"',
      '"updatedAt"',
      '"category"',
    ]);
  });

  it('el trigger es SECURITY INVOKER con search_path fijo y solo mira "category"', () => {
    const body = ALIAS.replace(/--[^\n]*/g, '');
    expect(body).toContain(
      'CREATE OR REPLACE FUNCTION public.dx_expense_category_legacy_alias() RETURNS trigger\n  LANGUAGE plpgsql\n  SET search_path = pg_catalog, pg_temp',
    );
    expect(body).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(body).toContain(
      'BEFORE INSERT OR UPDATE OF "category" ON "expenses"',
    );
  });
});
