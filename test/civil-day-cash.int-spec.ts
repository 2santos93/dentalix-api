import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClinicRole, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPaymentRepository } from '../src/modules/payments/infrastructure/repositories/prisma-payment.repository';
import { ListCashPaymentsUseCase } from '../src/modules/payments/application/use-cases/list-cash-payments.use-case';
import { GetPaymentsTotalsUseCase } from '../src/modules/payments/application/use-cases/get-payments-totals.use-case';
import type { ConvertAmountUseCase } from '../src/modules/exchange/application/use-cases/convert-amount.use-case';

// DX-097, capa de BD: los períodos de caja y dashboard se cortan en la zona
// IANA de CADA sede (de su horario en BD), contra Postgres y bajo RLS.

const owner = new PrismaClient({
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
const identityConvert = {
  execute: (input: {
    amount: number;
    from: string;
    to: string;
    date: string;
  }) => Promise.resolve({ ...input, result: input.amount, rateUsed: 1 }),
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

    const sede = async (
      tenantId: string,
      name: string,
      country: 'CO' | 'ES',
      timezone: string | null,
    ) => {
      const loc = await owner.location.create({
        data: { tenantId, name, country },
      });
      if (timezone) {
        await owner.locationSchedule.create({
          data: { tenantId, locationId: loc.id, timezone },
        });
      }
      return loc.id;
    };
    bogota = await sede(tenantA, 'Bogotá', 'CO', 'America/Bogota');
    // Sede de España SIN horario: la zona sale de su país (Europe/Madrid).
    madrid = await sede(tenantA, 'Madrid', 'ES', null);
    bogotaB = await sede(tenantB, 'Bogotá B', 'CO', 'America/Bogota');

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
      }),
    );
    expect(created.paidAt.toISOString()).toBe('2026-12-01T11:00:00.000Z');
    expect(await cashIds(madrid, '2026-12-01')).toEqual([created.id]);
  });

  it('las ramas por zona usan el índice (tenantId, locationId, paidAt) de abonos activos', async () => {
    const plan = await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
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
    });
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    expect(text).toContain('payments_tenantId_locationId_paidAt_active_idx');
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
      // Sede retirada con horario en una zona que Postgres no conoce: cae a
      // la zona de su país (ES), sin abortar el despliegue.
      const retired = (
        await owner.location.create({
          data: {
            tenantId: tenantA,
            name: 'Retirada',
            country: 'ES',
            deletedAt: new Date(),
          },
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
