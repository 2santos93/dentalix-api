import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArgumentsHost, Logger } from '@nestjs/common';
import { CatalogKind, Prisma, PrismaClient } from '@prisma/client';
import { PrismaExceptionFilter } from '../src/shared/prisma/prisma-exception.filter';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

// DX-042 (DB-010, DB-011, DB-013, DB-016): reglas de dominio en la BASE, no solo
// en los casos de uso. Cada CHECK se prueba por SQL directo con el rol owner
// (DIRECT_URL, el camino de un script o un seed que no pasa por la app); los
// únicos de inventario y odontograma, por la misma ruta que la app
// (runWithTenant, rol dentalix_app sujeto a RLS).
//
// Las comprobaciones previas de las dos migraciones se ejecutan TAL CUAL están
// en el .sql (se extraen, no se copian), dentro de transacciones que acaban en
// ROLLBACK: la base queda como estaba.
function migration(name: string): string {
  return readFileSync(
    join(__dirname, `../prisma/migrations/${name}/migration.sql`),
    'utf8',
  );
}
const CHECKS_MIGRATION = migration('20261016130000_domain_checks');
const FK_MIGRATION = migration('20261016131000_currency_fks');
const ROW_SECURITY_OFF = 'SET LOCAL row_security = off;';
function preflightOf(sql: string): string {
  return /^DO \$\$[\s\S]*?^END \$\$;$/m.exec(sql)?.[0] ?? '';
}

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

class Rollback extends Error {}

interface Seeded {
  tenantId: string;
  locationA: string;
  locationB: string;
  patientId: string;
  planId: string;
}

const SUBDOMAIN = 'domain-checks';

async function seed(): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
  });
  const tenantId = tenant.id;
  // A la vez a propósito: la serie de recibos de las dos sale "SED" y el
  // trigger las ordena con un candado por clínica (DX-216).
  const [locationA, locationB] = await Promise.all(
    ['Sede A', 'Sede B'].map((name) =>
      raw.location.create({ data: { tenantId, name } }),
    ),
  );
  const patient = await raw.patient.create({
    data: { tenantId, firstName: 'Ana', lastName: 'Checks' },
  });
  const plan = await raw.treatmentPlan.create({
    data: { tenantId, patientId: patient.id, currency: 'USD' },
  });
  return {
    tenantId,
    locationA: locationA.id,
    locationB: locationB.id,
    patientId: patient.id,
    planId: plan.id,
  };
}

// Por subdominio, no por el id sembrado: si una corrida anterior se cortó a
// medias (p. ej. falló el seed), sus filas no dejan la clínica tomada y no
// tumban todos los tests de las corridas siguientes (DX-216).
async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: SUBDOMAIN },
    select: { id: true },
  });
  if (tenants.length === 0) return;
  const tenantId = tenants[0].id;
  const where = { tenantId };
  await raw.inventoryMovement.deleteMany({ where });
  await raw.inventoryItem.deleteMany({ where });
  await raw.installment.deleteMany({ where });
  await raw.paymentPlan.deleteMany({ where });
  await raw.payment.deleteMany({ where });
  await raw.treatmentPlanItem.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.toothRecord.deleteMany({ where });
  await raw.appointment.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: tenantId } });
}

describe('Reglas de dominio en la BD (DX-042, int)', () => {
  let s: Seeded;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    s = await seed();
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  // INSERT por SQL directo (owner, sin pasar por la app) con los valores dados.
  function insertPayment(amount: string, currency = 'USD'): Promise<number> {
    return raw.$executeRawUnsafe(
      `INSERT INTO "payments" ("id", "tenantId", "locationId", "treatmentPlanId", "patientId", "amount", "currency", "paidAt", "updatedAt")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::numeric, $7, now(), now())`,
      randomUUID(),
      s.tenantId,
      s.locationA,
      s.planId,
      s.patientId,
      amount,
      currency,
    );
  }

  function insertAppointment(startIso: string, endIso: string) {
    return raw.$executeRawUnsafe(
      `INSERT INTO "appointments" ("id", "tenantId", "locationId", "patientId", "providerId", "start", "end", "updatedAt")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::timestamp, $7::timestamp, now())`,
      randomUUID(),
      s.tenantId,
      s.locationA,
      s.patientId,
      randomUUID(),
      startIso,
      endIso,
    );
  }

  function insertPaymentPlan(
    totalToFinance: string,
    downPayment: string,
    installmentsCount: number,
    currency = 'USD',
  ) {
    return raw.$executeRawUnsafe(
      `INSERT INTO "payment_plans" ("id", "tenantId", "treatmentPlanId", "patientId", "currency", "totalToFinance", "downPayment", "installmentsCount", "periodicity", "startDate", "updatedAt")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::numeric, $7::numeric, $8, 'MONTHLY', now(), now())`,
      randomUUID(),
      s.tenantId,
      s.planId,
      s.patientId,
      currency,
      totalToFinance,
      downPayment,
      installmentsCount,
    );
  }

  describe('CHECK con nombre (SQL directo, sin la app)', () => {
    it.each(['0', '-5'])(
      'payments.amount = %s → payments_amount_positive',
      async (amount) => {
        await expect(insertPayment(amount)).rejects.toThrow(
          /payments_amount_positive/,
        );
      },
    );

    it('payments.currency en minúsculas → payments_currency_format', async () => {
      await expect(insertPayment('10', 'usd')).rejects.toThrow(
        /payments_currency_format/,
      );
    });

    it('un abono válido entra', async () => {
      await expect(insertPayment('10.50')).resolves.toBe(1);
    });

    it.each([
      ['end = start', '2026-11-02T10:00:00', '2026-11-02T10:00:00'],
      ['end < start', '2026-11-02T10:00:00', '2026-11-02T09:00:00'],
    ])(
      'appointments con %s → appointments_valid_range',
      async (_label, start, end) => {
        await expect(insertAppointment(start, end)).rejects.toThrow(
          /appointments_valid_range/,
        );
      },
    );

    it('una cita con end > start entra', async () => {
      await expect(
        insertAppointment('2026-11-02T10:00:00', '2026-11-02T10:30:00'),
      ).resolves.toBe(1);
    });

    it.each([
      ['downPayment > totalToFinance', '100', '150', 3],
      ['totalToFinance = 0', '0', '0', 3],
      ['downPayment < 0', '100', '-1', 3],
      ['installmentsCount = 0', '100', '0', 0],
      ['installmentsCount = 601', '100', '0', 601],
    ])(
      'payment_plans con %s → payment_plans_valid_amounts',
      async (_label, total, down, count) => {
        await expect(insertPaymentPlan(total, down, count)).rejects.toThrow(
          /payment_plans_valid_amounts/,
        );
      },
    );

    it("payment_plans.currency = 'usd' → payment_plans_currency_format", async () => {
      await expect(insertPaymentPlan('100', '0', 1, 'usd')).rejects.toThrow(
        /payment_plans_currency_format/,
      );
    });

    it("treatment_plans.currency = 'usd' → treatment_plans_currency_format", async () => {
      await expect(
        raw.$executeRawUnsafe(
          `UPDATE "treatment_plans" SET "currency" = 'usd' WHERE "id" = $1::uuid`,
          s.planId,
        ),
      ).rejects.toThrow(/treatment_plans_currency_format/);
    });

    it('installments.amount < 0 o sequence < 1 → installments_amount_nonneg', async () => {
      const plan = await raw.paymentPlan.create({
        data: {
          tenantId: s.tenantId,
          treatmentPlanId: s.planId,
          patientId: s.patientId,
          currency: 'USD',
          totalToFinance: 100,
          installmentsCount: 1,
          periodicity: 'MONTHLY',
          startDate: new Date('2026-11-01T00:00:00.000Z'),
        },
      });
      for (const [sequence, amount] of [
        [1, '-1'],
        [0, '10'],
      ] as const) {
        await expect(
          raw.$executeRawUnsafe(
            `INSERT INTO "installments" ("id", "tenantId", "paymentPlanId", "sequence", "dueDate", "amount", "updatedAt")
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now(), $5::numeric, now())`,
            randomUUID(),
            s.tenantId,
            plan.id,
            sequence,
            amount,
          ),
        ).rejects.toThrow(/installments_amount_nonneg/);
      }
    });

    it('treatment_plan_items.price < 0 → treatment_plan_items_price_nonneg', async () => {
      await expect(
        raw.$executeRawUnsafe(
          `INSERT INTO "treatment_plan_items" ("id", "tenantId", "planId", "toothNumber", "catalogItemId", "price", "updatedAt")
           VALUES ($1::uuid, $2::uuid, $3::uuid, '11', $4::uuid, -1, now())`,
          randomUUID(),
          s.tenantId,
          s.planId,
          randomUUID(),
        ),
      ).rejects.toThrow(/treatment_plan_items_price_nonneg/);
    });

    it('dental_catalog_items.defaultPrice < 0 → dental_catalog_items_default_price_nonneg', async () => {
      await expect(
        raw.$executeRawUnsafe(
          `INSERT INTO "dental_catalog_items" ("id", "tenantId", "code", "kind", "labelEs", "color", "defaultPrice", "updatedAt")
           VALUES ($1::uuid, $2::uuid, 'NEG', 'PROCEDURE', 'Negativo', '#000000', -1, now())`,
          randomUUID(),
          s.tenantId,
        ),
      ).rejects.toThrow(/dental_catalog_items_default_price_nonneg/);
    });

    it('inventario: minStock < 0 y cantidades fuera de regla → CHECK con nombre', async () => {
      await expect(
        raw.$executeRawUnsafe(
          `INSERT INTO "inventory_items" ("id", "tenantId", "locationId", "name", "unit", "minStock", "updatedAt")
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'Negativo', 'u', -1, now())`,
          randomUUID(),
          s.tenantId,
          s.locationA,
        ),
      ).rejects.toThrow(/inventory_items_minstock_nonneg/);

      const item = await raw.inventoryItem.create({
        data: {
          tenantId: s.tenantId,
          locationId: s.locationA,
          name: 'Algodón',
          unit: 'paquete',
        },
      });
      const movement = (type: string, quantity: string) =>
        raw.$executeRawUnsafe(
          `INSERT INTO "inventory_movements" ("id", "tenantId", "locationId", "itemId", "type", "quantity")
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"InventoryMovementType", $6::numeric)`,
          randomUUID(),
          s.tenantId,
          s.locationA,
          item.id,
          type,
          quantity,
        );
      for (const [type, quantity] of [
        ['IN', '0'],
        ['IN', '-1'],
        ['OUT', '0'],
        ['ADJUSTMENT', '0'],
      ]) {
        await expect(movement(type, quantity)).rejects.toThrow(
          /inventory_movements_qty/,
        );
      }
      await expect(movement('ADJUSTMENT', '-2')).resolves.toBe(1);
      await expect(movement('OUT', '1.5')).resolves.toBe(1);
    });

    it('currency que no está en el catálogo → FK payments_currency_fkey', async () => {
      await expect(insertPayment('10', 'ZZZ')).rejects.toThrow(
        /payments_currency_fkey/,
      );
    });
  });

  describe('PrismaExceptionFilter con errores REALES de Postgres', () => {
    // Escribe por la ruta de la app (runWithTenant, dentalix_app) saltándose
    // la DTO y el caso de uso, captura el error tal cual lo lanza Prisma y lo
    // pasa por el filtro global.
    async function responseFor(
      data: Partial<Prisma.PaymentUncheckedCreateInput>,
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const error: unknown = await prisma
        .runWithTenant(s.tenantId, (tx) =>
          tx.payment.create({
            data: {
              tenantId: s.tenantId,
              locationId: s.locationA,
              treatmentPlanId: s.planId,
              patientId: s.patientId,
              amount: 10,
              currency: 'USD',
              paidAt: new Date(),
              notes: 'Ana Pérez, alergia a la penicilina',
              ...data,
            },
          }),
        )
        .then(
          () => {
            throw new Error('la escritura debía fallar');
          },
          (e: unknown) => e,
        );
      const out = { status: 0, body: {} as Record<string, unknown> };
      const host = {
        switchToHttp: () => ({
          getResponse: () => ({
            status: (code: number) => {
              out.status = code;
              return {
                json: (body: Record<string, unknown>) => {
                  out.body = body;
                },
              };
            },
          }),
        }),
      } as unknown as ArgumentsHost;
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      new PrismaExceptionFilter().catch(
        error as Prisma.PrismaClientKnownRequestError,
        host,
      );
      jest.restoreAllMocks();
      return out;
    }

    function expectNoPostgresLeak(body: Record<string, unknown>): void {
      const text = JSON.stringify(body);
      expect(text).not.toMatch(
        /Failing row|DETAIL|payments|constraint|penicilina|precision/i,
      );
    }

    it('CHECK (importe negativo) → 400 genérico, sin DETAIL', async () => {
      const { status, body } = await responseFor({ amount: -1 });
      expect(status).toBe(400);
      expect(body.message).toBe(
        'Los datos enviados no cumplen las reglas de la clínica.',
      );
      expectNoPostgresLeak(body);
    });

    it('desbordamiento numérico (13 dígitos) → 400 genérico', async () => {
      const { status, body } = await responseFor({
        amount: new Prisma.Decimal('1234567890123'),
      });
      expect(status).toBe(400);
      expectNoPostgresLeak(body);
    });

    it('FK (moneda fuera del catálogo) → 409 genérico', async () => {
      const { status, body } = await responseFor({ currency: 'ZZZ' });
      expect(status).toBe(409);
      expect(body.message).toBe(
        'La operación hace referencia a datos que no existen o que están en uso.',
      );
      expectNoPostgresLeak(body);
    });
  });

  describe('insumo único por sede y sin distinguir mayúsculas (DB-011)', () => {
    function createItem(locationId: string, name: string) {
      return prisma.runWithTenant(s.tenantId, (tx) =>
        tx.inventoryItem.create({
          data: { tenantId: s.tenantId, locationId, name, unit: 'caja' },
        }),
      );
    }

    it('dos sedes pueden tener un insumo con el mismo nombre', async () => {
      await createItem(s.locationA, 'Guantes');
      await expect(createItem(s.locationB, 'Guantes')).resolves.toBeDefined();
    });

    it('en la misma sede, «Guantes» y «guantes» chocan (P2002)', async () => {
      await expect(createItem(s.locationA, 'guantes')).rejects.toMatchObject({
        code: 'P2002',
      });
    });

    it('un insumo retirado no bloquea el nombre', async () => {
      const item = await createItem(s.locationA, 'Eyector');
      await raw.inventoryItem.update({
        where: { id: item.id },
        data: { deletedAt: new Date() },
      });
      await expect(createItem(s.locationA, 'EYECTOR')).resolves.toBeDefined();
    });
  });

  describe('odontograma: un registro por ítem de plan (DB-013)', () => {
    function mirror(sourcePlanItemId: string) {
      return prisma.runWithTenant(s.tenantId, (tx) =>
        tx.toothRecord.create({
          data: {
            tenantId: s.tenantId,
            patientId: s.patientId,
            toothNumber: '11',
            kind: CatalogKind.PROCEDURE,
            sourcePlanItemId,
          },
        }),
      );
    }

    it('un segundo registro con el mismo sourcePlanItemId choca (P2002)', async () => {
      const itemId = randomUUID();
      await mirror(itemId);
      await expect(mirror(itemId)).rejects.toMatchObject({ code: 'P2002' });
    });

    it('los registros manuales (sin sourcePlanItemId) no se limitan', async () => {
      const manual = () =>
        prisma.runWithTenant(s.tenantId, (tx) =>
          tx.toothRecord.create({
            data: {
              tenantId: s.tenantId,
              patientId: s.patientId,
              toothNumber: '12',
              kind: CatalogKind.DIAGNOSIS,
            },
          }),
        );
      await manual();
      await expect(manual()).resolves.toBeDefined();
    });
  });

  describe('comprobación previa de 20261016130000_domain_checks', () => {
    const PREFLIGHT = preflightOf(CHECKS_MIGRATION);

    it('apaga row_security y bloquea las tablas ANTES de comprobar', () => {
      expect(PREFLIGHT).toContain('RAISE EXCEPTION');
      const rowSecurityAt = CHECKS_MIGRATION.indexOf(ROW_SECURITY_OFF);
      const firstLockAt = CHECKS_MIGRATION.search(/^LOCK TABLE /m);
      const preflightAt = CHECKS_MIGRATION.indexOf(PREFLIGHT);
      expect(rowSecurityAt).toBeGreaterThanOrEqual(0);
      expect(firstLockAt).toBeGreaterThan(rowSecurityAt);
      expect(preflightAt).toBeGreaterThan(firstLockAt);
      // Ningún ALTER/CREATE antes de la comprobación.
      expect(CHECKS_MIGRATION.slice(0, preflightAt)).not.toMatch(
        /^(ALTER|CREATE|DROP) /m,
      );
    });

    it('bloquea en ACCESS EXCLUSIVE, desde el principio, cada tabla que recibe un CHECK (sin escalar el lock)', () => {
      // ADD CONSTRAINT CHECK pide ACCESS EXCLUSIVE. Si antes solo se tomó
      // SHARE ROW EXCLUSIVE, la migración ESCALA el lock: una transacción de la
      // app que ya leyó la tabla (ACCESS SHARE) y luego quiere escribir
      // (ROW EXCLUSIVE) espera a la migración, y la migración espera a que esa
      // transacción suelte su ACCESS SHARE → interbloqueo.
      const preflightAt = CHECKS_MIGRATION.indexOf(PREFLIGHT);
      const head = CHECKS_MIGRATION.slice(0, preflightAt);
      const exclusive = [
        ...head.matchAll(/^LOCK TABLE ([^;]+?)\s+IN ACCESS EXCLUSIVE MODE;/gm),
      ]
        .flatMap((m) => m[1].split(','))
        .map((t) => t.trim().replace(/"/g, ''));
      const checked = [
        ...CHECKS_MIGRATION.matchAll(
          /^ALTER TABLE "([a-z_]+)"\s+ADD CONSTRAINT "[a-z_]+" CHECK/gm,
        ),
      ].map((m) => m[1]);
      expect(checked.length).toBeGreaterThanOrEqual(8);
      for (const table of checked) {
        expect(exclusive).toContain(table);
      }
      // Y sin esperar indefinidamente con todo el tráfico encolado detrás.
      expect(head).toMatch(/^SET LOCAL lock_timeout = '\d+s';$/m);
    });

    it('con datos válidos, la comprobación pasa', async () => {
      await raw.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(ROW_SECURITY_OFF);
        await tx.$executeRawUnsafe(PREFLIGHT);
      });
    });

    it('con filas inválidas, aborta con RAISE y el desglose por regla', async () => {
      const dirty = raw.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(ROW_SECURITY_OFF);
        await tx.$executeRawUnsafe(
          'ALTER TABLE "payments" DROP CONSTRAINT "payments_amount_positive"',
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE "appointments" DROP CONSTRAINT "appointments_valid_range"',
        );
        await tx.$executeRawUnsafe(
          'DROP INDEX "inventory_items_tenant_location_name_key"',
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "payments" ("id", "tenantId", "locationId", "treatmentPlanId", "patientId", "amount", "currency", "paidAt", "updatedAt")
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, -1, 'USD', now(), now()),
                  (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, 0, 'USD', now(), now())`,
          s.tenantId,
          s.locationA,
          s.planId,
          s.patientId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "appointments" ("id", "tenantId", "locationId", "patientId", "providerId", "start", "end", "updatedAt")
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, gen_random_uuid(), '2026-12-01T10:00:00', '2026-12-01T10:00:00', now())`,
          s.tenantId,
          s.locationA,
          s.patientId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "inventory_items" ("id", "tenantId", "locationId", "name", "unit", "updatedAt")
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'Fresas', 'u', now()),
                  (gen_random_uuid(), $1::uuid, $2::uuid, 'FRESAS', 'u', now())`,
          s.tenantId,
          s.locationA,
        );
        await tx.$executeRawUnsafe(PREFLIGHT);
        throw new Rollback('la comprobación debía fallar');
      });

      await expect(dirty).rejects.toThrow(
        /DX-042[\s\S]*payments\.amount > 0: 2[\s\S]*appointments\.end > start: 1[\s\S]*inventory_items \(tenantId, locationId, lower\(name\)\) duplicados: 1/,
      );
      // ROLLBACK: las constraints siguen.
      const constraints = await raw.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_constraint
         WHERE conname IN ('payments_amount_positive', 'appointments_valid_range')`;
      expect(Number(constraints[0].n)).toBe(2);
    });

    it('un rol sujeto a RLS no puede contar de menos en silencio', async () => {
      const app = new PrismaClient<Prisma.PrismaClientOptions>({
        datasources: { db: { url: process.env.DATABASE_URL } },
      });
      try {
        const asApp = app.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(ROW_SECURITY_OFF);
          await tx.$executeRawUnsafe(PREFLIGHT);
        });
        await expect(asApp).rejects.toThrow(/row-level security/);
      } finally {
        await app.$disconnect();
      }
    });
  });

  describe('comprobación previa de 20261016131000_currency_fks', () => {
    const PREFLIGHT = preflightOf(FK_MIGRATION);

    it('pone lock_timeout antes de bloquear las tablas', () => {
      const firstLockAt = FK_MIGRATION.search(/^LOCK TABLE /m);
      expect(FK_MIGRATION.slice(0, firstLockAt)).toMatch(
        /^SET LOCAL lock_timeout = '\d+s';$/m,
      );
    });

    it('con datos válidos, la comprobación pasa', async () => {
      expect(PREFLIGHT).toContain('RAISE EXCEPTION');
      await raw.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(ROW_SECURITY_OFF);
        await tx.$executeRawUnsafe(PREFLIGHT);
      });
    });

    it('con una moneda fuera del catálogo, aborta con el desglose', async () => {
      const dirty = raw.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.$executeRawUnsafe(ROW_SECURITY_OFF);
        await tx.$executeRawUnsafe(
          'ALTER TABLE "treatment_plans" DROP CONSTRAINT "treatment_plans_currency_fkey"',
        );
        await tx.$executeRawUnsafe(
          `UPDATE "treatment_plans" SET "currency" = 'XYZ' WHERE "id" = $1::uuid`,
          s.planId,
        );
        await tx.$executeRawUnsafe(PREFLIGHT);
        throw new Rollback('la comprobación debía fallar');
      });
      await expect(dirty).rejects.toThrow(
        /DX-042[\s\S]*treatment_plans\.currency: 1/,
      );
    });
  });
});
