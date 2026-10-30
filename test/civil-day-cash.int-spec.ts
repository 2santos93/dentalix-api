import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPaymentRepository } from '../src/modules/payments/infrastructure/repositories/prisma-payment.repository';
import { ListCashPaymentsUseCase } from '../src/modules/payments/application/use-cases/list-cash-payments.use-case';
import { GetPaymentsTotalsUseCase } from '../src/modules/payments/application/use-cases/get-payments-totals.use-case';
import type { ConvertAmountUseCase } from '../src/modules/exchange/application/use-cases/convert-amount.use-case';
import {
  REGIONAL_BOGOTA_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
  legacyLocationInsert,
  locationData,
} from './support/location-fixtures';

// DX-097, capa de BD: los períodos de caja y dashboard se cortan en la zona
// IANA de CADA sede (de su horario en BD), contra Postgres y bajo RLS.

const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaPaymentRepository(prisma, tenantContext);
// 17/10/2026 10:00 en Bogotá: solo decide `canVoid`, no el período.
const cash = new ListCashPaymentsUseCase(
  repo,
  () => new Date('2026-10-17T15:00:00.000Z'),
);
// Tasa 1:1: aquí importa QUÉ abonos entran, no la conversión.
const identityExecute = (input: {
  amount: number;
  from: string;
  to: string;
  date: string;
}) => Promise.resolve({ ...input, result: input.amount, rateUsed: 1 });
// DX-374: los totales piden un convertidor memoizado por cálculo.
const identityConvert = {
  execute: identityExecute,
  memoized: () => ({ execute: identityExecute }),
} as unknown as ConvertAmountUseCase;
const totals = new GetPaymentsTotalsUseCase(repo, identityConvert);
const ADMIN = { userId: 'int-admin', role: ClinicRole.ADMIN };

const SUBDOMAINS = ['dx097-int-a', 'dx097-int-b'];

async function purge(): Promise<void> {
  const tenants = await owner.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  const where = { tenantId: { in: ids } };
  await owner.$executeRawUnsafe(
    'DELETE FROM payments_paidat_backfill_dx097 WHERE "tenantId" = ANY($1::uuid[])',
    ids,
  );
  // DX-051: los abonos por repositorio dejan base, imputaciones e historial
  // (borrar las imputaciones deja su movimiento: van antes).
  await owner.paymentAllocation.deleteMany({ where });
  await owner.paymentAllocationMovement.deleteMany({ where });
  await owner.paymentPlanAmount.deleteMany({ where });
  await owner.payment.deleteMany({ where });
  await owner.treatmentPlan.deleteMany({ where });
  await owner.patient.deleteMany({ where });
  await owner.locationSchedule.deleteMany({ where });
  await owner.location.deleteMany({ where });
  await owner.tenant.deleteMany({ where: { id: { in: ids } } });
}

describe('DX-097 · días civiles de la sede en caja y dashboard (int)', () => {
  let tenantA: string;
  let tenantB: string;
  let bogota: string;
  let madrid: string;
  let bogotaB: string;
  let planA: string;
  let patientA: string;
  const ids: Record<string, string> = {};

  const inA = <T>(locationId: string | undefined, fn: () => Promise<T>) =>
    tenantContext.run(tenantA, locationId, fn);

  const cashIds = async (
    locationId: string | undefined,
    from: string,
    to = from,
  ) =>
    inA(locationId, async () => {
      const out = await cash.execute({ from, to, pageSize: 100 }, ADMIN);
      return out.items.map((i) => i.id).sort();
    });

  const idsOf = (...keys: string[]) => keys.map((k) => ids[k]).sort();

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purge();
    const [a, b] = await Promise.all(
      SUBDOMAINS.map((subdomain) =>
        owner.tenant.create({ data: { name: subdomain, subdomain } }),
      ),
    );
    tenantA = a.id;
    tenantB = b.id;

    // G1: la zona es de la sede (`Location.timeZone`). El horario, si lo hay,
    // lleva la misma zona en su columna legada (R20): la lee la migración de
    // DX-097 que se prueba abajo.
    const sede = async (
      tenantId: string,
      name: string,
      country: 'CO' | 'ES',
      timeZone: string,
      withSchedule: boolean,
    ) => {
      const loc = await owner.location.create({
        data: locationData(REGIONAL_BOGOTA_FIXTURE, {
          tenantId,
          name,
          country,
          timeZone,
        }),
      });
      if (withSchedule) {
        await owner.locationSchedule.create({
          data: { tenantId, locationId: loc.id, timezone: timeZone },
        });
      }
      return loc.id;
    };
    bogota = await sede(tenantA, 'Bogotá', 'CO', 'America/Bogota', true);
    // Sede de España SIN horario: su zona es la de la sede (Europe/Madrid).
    madrid = await sede(tenantA, 'Madrid', 'ES', 'Europe/Madrid', false);
    bogotaB = await sede(tenantB, 'Bogotá B', 'CO', 'America/Bogota', true);

    patientA = (
      await owner.patient.create({
        data: { tenantId: tenantA, firstName: 'Ana', lastName: 'A' },
      })
    ).id;
    planA = (
      await owner.treatmentPlan.create({
        data: { tenantId: tenantA, patientId: patientA, currency: 'COP' },
      })
    ).id;
    const patientB = (
      await owner.patient.create({
        data: { tenantId: tenantB, firstName: 'Beto', lastName: 'B' },
      })
    ).id;
    const planB = (
      await owner.treatmentPlan.create({
        data: { tenantId: tenantB, patientId: patientB, currency: 'COP' },
      })
    ).id;

    const pay = async (
      key: string,
      locationId: string,
      paidAt: string,
      amount = 100,
    ) => {
      const isB = locationId === bogotaB;
      ids[key] = (
        await owner.payment.create({
          data: {
            tenantId: isB ? tenantB : tenantA,
            locationId,
            treatmentPlanId: isB ? planB : planA,
            patientId: isB ? patientB : patientA,
            amount,
            currency: 'COP',
            paidAt: new Date(paidAt),
          },
        })
      ).id;
    };
    // 16/10 20:00 en Bogotá = 17/10 01:00 UTC.
    await pay('bogEvening', bogota, '2026-10-17T01:00:00.000Z', 80000);
    // 17/10 09:00 en Bogotá.
    await pay('bogNextMorning', bogota, '2026-10-17T14:00:00.000Z', 1);
    // 16/10 01:00 en Madrid (CEST) = 15/10 23:00 UTC = 15/10 18:00 en Bogotá.
    await pay('madEarly', madrid, '2026-10-15T23:00:00.000Z', 2);
    // 17/10 00:30 en Madrid = 16/10 22:30 UTC = 16/10 17:30 en Bogotá.
    await pay('madAfterMidnight', madrid, '2026-10-16T22:30:00.000Z', 4);
    // Cambio de mes: 31/10 22:00 y 01/11 00:30 en Bogotá.
    await pay('bogOct31Late', bogota, '2026-11-01T03:00:00.000Z', 1000);
    await pay('bogNov1Early', bogota, '2026-11-01T05:30:00.000Z', 7);
    // 30/09 23:59 en Bogotá (01/10 04:59 UTC): septiembre.
    await pay('bogSep30Late', bogota, '2026-10-01T04:59:00.000Z', 9);
    // Otra clínica, mismo día.
    await pay('otherTenant', bogotaB, '2026-10-17T01:00:00.000Z', 5);
  });

  afterAll(async () => {
    await purge();
    await prisma.$disconnect();
    await owner.$disconnect();
  });

  it('un abono a las 20:00 de Bogotá está en la caja de «hoy» (D) de su sede y no en D+1', async () => {
    expect(await cashIds(bogota, '2026-10-16')).toEqual(idsOf('bogEvening'));
    expect(await cashIds(bogota, '2026-10-17')).toEqual(
      idsOf('bogNextMorning'),
    );
  });

  it('la fila trae su día civil en la zona de la sede (paidOn)', async () => {
    const out = await inA(bogota, () =>
      cash.execute({ from: '2026-10-16', to: '2026-10-16' }, ADMIN),
    );
    expect(out.items).toHaveLength(1);
    expect(out.items[0].paidAt.toISOString()).toBe('2026-10-17T01:00:00.000Z');
    expect(out.items[0].paidOn).toBe('2026-10-16');
    expect(out.summary.byCurrency).toEqual([
      { currency: 'COP', total: 80000, count: 1 },
    ]);
  });

  it('dos sedes en zonas distintas: cada una corta su día en su zona', async () => {
    // Madrid (sin horario: zona de su país).
    expect(await cashIds(madrid, '2026-10-16')).toEqual(idsOf('madEarly'));
    expect(await cashIds(madrid, '2026-10-17')).toEqual(
      idsOf('madAfterMidnight'),
    );
    // Vista consolidada: el 16 de CADA sede, en su zona.
    expect(await cashIds(undefined, '2026-10-16')).toEqual(
      idsOf('bogEvening', 'madEarly'),
    );
    expect(await cashIds(undefined, '2026-10-17')).toEqual(
      idsOf('bogNextMorning', 'madAfterMidnight'),
    );
  });

  it('el resumen mensual incluye el 31 a las 22:00 y excluye el 1 del mes siguiente a las 00:30 (hora de la sede)', async () => {
    const october = await inA(bogota, () =>
      totals.execute({ from: '2026-10-01', to: '2026-10-31', currency: 'COP' }),
    );
    // bogEvening + bogNextMorning + bogOct31Late; ni bogNov1Early ni bogSep30Late.
    expect(october.count).toBe(3);
    expect(october.byCurrency).toEqual({ COP: 81001 });

    const november = await inA(bogota, () =>
      totals.execute({ from: '2026-11-01', to: '2026-11-30', currency: 'COP' }),
    );
    expect(november.byCurrency).toEqual({ COP: 7 });
  });

  it('la caja de un rango from/to es inclusiva en los dos extremos en la zona de la sede', async () => {
    expect(await cashIds(bogota, '2026-10-01', '2026-10-31')).toEqual(
      idsOf('bogEvening', 'bogNextMorning', 'bogOct31Late'),
    );
    expect(await cashIds(bogota, '2026-09-30', '2026-09-30')).toEqual(
      idsOf('bogSep30Late'),
    );
  });

  it('aislamiento por tenant intacto: la caja de A nunca ve el abono de B', async () => {
    const all = await cashIds(undefined, '2026-10-01', '2026-11-30');
    expect(all).not.toContain(ids.otherTenant);
    const onlyB = await tenantContext.run(tenantB, async () => {
      const out = await cash.execute(
        { from: '2026-10-16', to: '2026-10-16' },
        ADMIN,
      );
      return out.items.map((i) => i.id);
    });
    expect(onlyB).toEqual([ids.otherTenant]);
  });

  it('un abono registrado solo con fecha se guarda al mediodía de SU sede', async () => {
    const created = await inA(madrid, () =>
      repo.create({
        treatmentPlanId: planA,
        patientId: patientA,
        amount: 3,
        currency: 'COP',
        paidAt: { civilDate: '2026-12-01' },
        receiptPlanBalance: null,
        planAmount: null,
      }),
    );
    expect(created.paidAt.toISOString()).toBe('2026-12-01T11:00:00.000Z');
    expect(await cashIds(madrid, '2026-12-01')).toEqual([created.id]);
  });

  it('las ramas por zona usan el índice (tenantId, locationId, paidAt) de abonos activos', async () => {
    // Con un puñado de filas todos los índices de `payments` que empiezan por
    // (o contienen) "tenantId" cuestan casi lo mismo y el planificador
    // desempata por el más nuevo (DX-051 añadió payments_tenant_id_plan_key).
    // Se siembran abonos de la clínica en otros días y se analiza, como en
    // producción, dentro de una transacción que se deshace. Las filas y
    // pg_statistic se deshacen, pero ANALYZE escribe reltuples/relpages de
    // pg_class en el sitio: se vuelve a analizar tras el rollback.
    const rollback = new Error('rollback');
    let plan: { 'QUERY PLAN': string }[] = [];
    await owner
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "payments" ("id", "tenantId", "locationId", "treatmentPlanId", "patientId", "amount", "currency", "paidAt", "updatedAt")
           SELECT gen_random_uuid(), $1::uuid,
                  CASE WHEN g % 2 = 0 THEN $2::uuid ELSE $3::uuid END,
                  $4::uuid, $5::uuid, 1, 'COP',
                  timestamp '2025-01-01 15:00' + g * interval '1 day', now()
             FROM generate_series(1, 300) AS g`,
          tenantA,
          bogota,
          madrid,
          planA,
          patientA,
        );
        await tx.$executeRawUnsafe('ANALYZE "payments"');
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        plan = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
          `EXPLAIN SELECT "id" FROM "payments"
          WHERE "tenantId" = $1::uuid AND "deletedAt" IS NULL
            AND (("locationId" = ANY($2::uuid[]) AND "paidAt" >= $3 AND "paidAt" < $4)
              OR ("locationId" = ANY($5::uuid[]) AND "paidAt" >= $6 AND "paidAt" < $7))`,
          tenantA,
          [bogota],
          new Date('2026-10-16T05:00:00.000Z'),
          new Date('2026-10-17T05:00:00.000Z'),
          [madrid],
          new Date('2026-10-15T22:00:00.000Z'),
          new Date('2026-10-16T22:00:00.000Z'),
        );
        throw rollback;
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error;
      });
    await owner.$executeRawUnsafe('ANALYZE "payments"');
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    expect(text).toContain('payments_tenantId_locationId_paidAt_active_idx');
  });

  /** Abono directo (owner) en una sede de A; se borra con `dropPayments`. */
  const payAt = async (locationId: string, paidAt: string) =>
    (
      await owner.payment.create({
        data: {
          tenantId: tenantA,
          locationId,
          treatmentPlanId: planA,
          patientId: patientA,
          amount: 1,
          currency: 'COP',
          paidAt: new Date(paidAt),
        },
      })
    ).id;
  const dropPayments = async (paymentIds: string[]) => {
    await owner.paymentAllocation.deleteMany({
      where: { paymentId: { in: paymentIds } },
    });
    await owner.payment.deleteMany({ where: { id: { in: paymentIds } } });
  };

  it('cash day cut at Tokyo midnight', async () => {
    const tokyo = (
      await owner.location.create({
        data: locationData(REGIONAL_TOKYO_FIXTURE, {
          tenantId: tenantA,
          name: 'Tokio',
        }),
      })
    ).id;
    // 20/10 23:59 y 21/10 00:00 en Tokio (UTC+9, sin horario de verano).
    const before = await payAt(tokyo, '2026-10-20T14:59:00.000Z');
    const after = await payAt(tokyo, '2026-10-20T15:00:00.000Z');
    try {
      expect(await cashIds(tokyo, '2026-10-20')).toEqual([before]);
      expect(await cashIds(tokyo, '2026-10-21')).toEqual([after]);
      // Consolidada: también en su zona, junto a las de Bogotá y Madrid.
      expect(await cashIds(undefined, '2026-10-21')).toEqual([after]);
    } finally {
      await dropPayments([before, after]);
      await owner.location.delete({ where: { id: tokyo } });
    }
  });

  describe('sede sin zona (réplica antigua) en la vista de toda la clínica', () => {
    let legacy: string;

    beforeAll(async () => {
      legacy = await legacyLocationInsert(
        owner,
        tenantA,
        'Réplica antigua',
        REGIONAL_BOGOTA_FIXTURE.country,
      );
    });

    afterAll(async () => {
      await owner.location.delete({ where: { id: legacy } });
    });

    it('tenant-wide view ignores an unconfigured location without movements', async () => {
      // Caja y dashboard consolidados siguen funcionando.
      expect(await cashIds(undefined, '2026-10-16')).toEqual(
        idsOf('bogEvening', 'madEarly'),
      );
      const month = await inA(undefined, () =>
        totals.execute({
          from: '2026-10-01',
          to: '2026-10-31',
          currency: 'COP',
        }),
      );
      expect(month.count).toBeGreaterThan(0);
      // Pedir esa sede sí necesita su zona.
      await expect(cashIds(legacy, '2026-10-16')).rejects.toMatchObject({
        response: { code: 'LOCATION_TIMEZONE_REQUIRED', locationId: legacy },
      });
    });

    it('tenant-wide view with movements at an unconfigured location is 409 LOCATION_TIMEZONE_REQUIRED', async () => {
      const paid = await payAt(legacy, '2026-10-16T17:00:00.000Z');
      try {
        const conflict = {
          response: { code: 'LOCATION_TIMEZONE_REQUIRED', locationId: legacy },
        };
        await expect(cashIds(undefined, '2026-10-16')).rejects.toMatchObject(
          conflict,
        );
        await expect(
          inA(undefined, () =>
            totals.execute({
              from: '2026-10-01',
              to: '2026-10-31',
              currency: 'COP',
            }),
          ),
        ).rejects.toMatchObject(conflict);
        // La caja de otra sede no la necesita.
        expect(await cashIds(bogota, '2026-10-16')).toEqual(
          idsOf('bogEvening'),
        );
      } finally {
        await dropPayments([paid]);
      }
    });
  });

  describe('migración 20261017113000_payments_civil_day_noon', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../prisma/migrations/20261017113000_payments_civil_day_noon/migration.sql',
      ),
      'utf8',
    );
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    const runMigration = () =>
      owner.$transaction(async (tx) => {
        for (const statement of statements) {
          await tx.$executeRawUnsafe(statement);
        }
        // La migración recrea la política con el cast directo; DX-251 la dejó
        // con NULLIF. Se restaura para que rls-catalog vea la BD como queda
        // tras todas las migraciones, sea cual sea el orden de los ficheros.
        await tx.$executeRawUnsafe(
          `ALTER POLICY "tenant_isolation" ON "payments_paidat_backfill_dx097"
             USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
             WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)`,
        );
      });

    it('mueve las medianoches UTC (días del formulario) al mediodía de la sede, deja rastro y no toca los instantes reales', async () => {
      await pay2('legacyBog', bogota, '2026-10-16T00:00:00.000Z');
      await pay2('legacyMad', madrid, '2026-10-16T00:00:00.000Z');
      // Anulado: se mueve igual (su día de caja también era ese).
      await pay2(
        'legacyVoided',
        bogota,
        '2026-10-18T00:00:00.000Z',
        new Date(),
      );
      // Sede retirada con horario en una zona que Postgres no conoce: la
      // migración de DX-097 (anterior a G1, lee el horario legado) cae a la
      // zona de su país (ES), sin abortar el despliegue.
      const retired = (
        await owner.location.create({
          data: locationData(REGIONAL_BOGOTA_FIXTURE, {
            tenantId: tenantA,
            name: 'Retirada',
            country: 'ES',
            timeZone: 'Europe/Madrid',
            deletedAt: new Date(),
          }),
        })
      ).id;
      await owner.locationSchedule.create({
        data: {
          tenantId: tenantA,
          locationId: retired,
          timezone: 'Mars/Olympus',
        },
      });
      await pay2('legacyRetired', retired, '2026-10-19T00:00:00.000Z');

      await runMigration();

      const rows = await owner.payment.findMany({
        where: { tenantId: tenantA },
        select: { id: true, paidAt: true },
      });
      const at = (key: string) =>
        rows.find((r) => r.id === ids[key])!.paidAt.toISOString();
      expect(at('legacyBog')).toBe('2026-10-16T17:00:00.000Z');
      expect(at('legacyMad')).toBe('2026-10-16T10:00:00.000Z');
      expect(at('legacyVoided')).toBe('2026-10-18T17:00:00.000Z');
      expect(at('legacyRetired')).toBe('2026-10-19T10:00:00.000Z');
      expect(at('bogEvening')).toBe('2026-10-17T01:00:00.000Z');
      // El día de caja es el que se eligió en el formulario.
      expect(await cashIds(bogota, '2026-10-16')).toEqual(
        idsOf('bogEvening', 'legacyBog'),
      );
      expect(await cashIds(madrid, '2026-10-16')).toEqual(
        idsOf('madEarly', 'legacyMad'),
      );

      // Rastro: valor viejo, nuevo y zona de cada fila movida.
      const trail = await owner.$queryRawUnsafe<
        {
          payment_id: string;
          old_paid_at: Date;
          new_paid_at: Date;
          time_zone: string;
        }[]
      >(
        'SELECT payment_id, old_paid_at, new_paid_at, time_zone FROM payments_paidat_backfill_dx097 WHERE "tenantId" = $1::uuid',
        tenantA,
      );
      const byId = new Map(trail.map((t) => [t.payment_id, t]));
      expect(byId.get(ids.legacyBog)).toMatchObject({
        old_paid_at: new Date('2026-10-16T00:00:00.000Z'),
        new_paid_at: new Date('2026-10-16T17:00:00.000Z'),
        time_zone: 'America/Bogota',
      });
      expect(byId.get(ids.legacyRetired)?.time_zone).toBe('Europe/Madrid');
      expect(byId.has(ids.bogEvening)).toBe(false);
      expect(trail).toHaveLength(4);

      // Segunda ejecución: no cambia nada ni duplica el rastro.
      await runMigration();
      const again = await owner.payment.findMany({
        where: { tenantId: tenantA },
        select: { id: true, paidAt: true },
      });
      expect(again.map((r) => [r.id, r.paidAt.toISOString()]).sort()).toEqual(
        rows.map((r) => [r.id, r.paidAt.toISOString()]).sort(),
      );
      const [{ count }] = await owner.$queryRawUnsafe<{ count: bigint }[]>(
        'SELECT count(*) AS count FROM payments_paidat_backfill_dx097 WHERE "tenantId" = $1::uuid',
        tenantA,
      );
      expect(Number(count)).toBe(4);
    });

    it('la tabla de rastro no es visible para el rol de la app (RLS forzada, sin GRANT)', async () => {
      await expect(
        inA(undefined, () =>
          prisma.runWithTenant((tx) =>
            tx.$queryRawUnsafe('SELECT 1 FROM payments_paidat_backfill_dx097'),
          ),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    async function pay2(
      key: string,
      locationId: string,
      paidAt: string,
      deletedAt?: Date,
    ) {
      ids[key] = (
        await owner.payment.create({
          data: {
            tenantId: tenantA,
            locationId,
            treatmentPlanId: planA,
            patientId: patientA,
            amount: 50,
            currency: 'COP',
            paidAt: new Date(paidAt),
            deletedAt: deletedAt ?? null,
          },
        })
      ).id;
    }
  });
});
