import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPatientCreditRepository } from '../src/modules/patient-credit/infrastructure/prisma-patient-credit.repository';
import { PrismaReceivablesRepository } from '../src/modules/receivables/infrastructure/prisma-receivables.repository';
import type { PlanCreditFacts } from '../src/modules/receivables/domain/entities/credit-balances.entity';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-430 (ronda 1, M3): la lectura de «de dónde viene el saldo» contra la BD
// real: la recursión por traspasos (un plan que recibió el saldo no tiene
// abonos propios), la sede del propio plan, la conversión por base y el
// prefiltro de candidatos. `raw` (DIRECT_URL) siembra; lo que se prueba va
// como dentalix_app, bajo RLS.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const credit = new PrismaPatientCreditRepository(prisma, tenantContext);
const receivables = new PrismaReceivablesRepository(prisma, tenantContext);

const SUBDOMAIN = 'dx430-int-a';
const EMAIL = 'dx430-int@example.com';

let tenantId: string;
let sedeA: string;
let sedeB: string;
let patientId: string;
let userId: string;

const inContext = <T>(fn: () => Promise<T>) =>
  tenantContext.run(tenantId, sedeA, fn);

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: SUBDOMAIN },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length > 0) {
    const where = { tenantId: { in: ids } };
    await raw.patientCreditEntry.deleteMany({ where });
    await raw.patientCreditRefundPayment.deleteMany({ where });
    await raw.patientCreditRefund.deleteMany({ where });
    await raw.patientCreditTransfer.deleteMany({ where });
    await raw.patientCreditRefundCounter.deleteMany({ where });
    await raw.paymentReceipt.deleteMany({ where });
    await raw.paymentPlanAmount.deleteMany({ where });
    await raw.payment.deleteMany({ where });
    await raw.treatmentPlan.deleteMany({ where });
    await raw.patientLedger.deleteMany({ where });
    await raw.patient.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.tenant.deleteMany({ where: { id: { in: ids } } });
  }
  await raw.user.deleteMany({ where: { email: EMAIL } });
}

async function plan(
  status: 'ACCEPTED' | 'CANCELLED' | 'DRAFT',
  extra: Partial<Prisma.TreatmentPlanUncheckedCreateInput> = {},
): Promise<string> {
  return (
    await raw.treatmentPlan.create({
      data: { tenantId, patientId, currency: 'VES', status, ...extra },
    })
  ).id;
}

async function pay(
  planId: string,
  amount: number,
  paidAt: string,
  locationId: string,
  currency = 'VES',
): Promise<string> {
  return (
    await raw.payment.create({
      data: {
        tenantId,
        locationId,
        treatmentPlanId: planId,
        patientId,
        amount,
        currency,
        paidAt: new Date(paidAt),
        method: 'CASH',
      },
    })
  ).id;
}

describe('DX-430 · hechos del saldo a favor contra la BD (int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    userId = (
      await raw.user.create({
        data: { email: EMAIL, fullName: 'Admin', passwordHash: 'x' },
      })
    ).id;
    const tenant = await raw.tenant.create({
      data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
    });
    tenantId = tenant.id;
    sedeA = (
      await raw.location.create({
        data: locationData(REGIONAL_CARACAS_FIXTURE, {
          tenantId,
          name: 'Sede A',
          country: 'VE',
        }),
      })
    ).id;
    sedeB = (
      await raw.location.create({
        data: locationData(REGIONAL_CARACAS_FIXTURE, {
          tenantId,
          name: 'Sede B',
          country: 'VE',
        }),
      })
    ).id;
    patientId = (
      await raw.patient.create({
        data: {
          tenantId,
          firstName: 'Ana',
          lastName: 'Hechos',
          docNumber: `${SUBDOMAIN}-1`,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await raw.$disconnect();
  });

  it('un plan que recibió el saldo por traspaso no tiene abonos propios: sus hechos traen los del plan de origen, el más antiguo primero, con su sede', async () => {
    const source = await plan('ACCEPTED');
    await pay(source, 100, '2026-03-01T15:00:00.000Z', sedeB);
    await pay(source, 200, '2026-02-01T15:00:00.000Z', sedeA);
    await raw.treatmentPlan.update({
      where: { id: source },
      data: { status: 'CANCELLED' },
    });
    const target = await plan('ACCEPTED');
    await inContext(() =>
      credit.createTransfer({
        sourcePlanId: source,
        targetPlanId: target,
        amountCents: 30_000,
        currency: 'VES',
        reason: null,
        userId,
        fingerprint: 'f1',
      }),
    );

    const facts = await inContext(() => receivables.planCreditFacts([target]));

    const f = facts.get(target)!;
    expect(f.ownPayments).toEqual([]);
    expect(
      f.transferredPayments.map((p) => [
        p.paidAt.toISOString(),
        p.locationId,
        p.planCents,
      ]),
    ).toEqual([
      ['2026-02-01T15:00:00.000Z', sedeA, 20_000],
      ['2026-03-01T15:00:00.000Z', sedeB, 10_000],
    ]);
  });

  it('un plan con abonos propios no trae los traspasados; la sede del plan es la de aceptación, si no la de presentación', async () => {
    const own = await plan('ACCEPTED', { acceptedLocationId: sedeB });
    await pay(own, 50, '2026-04-01T15:00:00.000Z', sedeA);
    const presented = await plan('ACCEPTED', { presentedLocationId: sedeA });
    const none = await plan('ACCEPTED');

    const facts = await inContext(() =>
      receivables.planCreditFacts([own, presented, none]),
    );

    expect(facts.get(own)).toMatchObject({
      planLocationId: sedeB,
      transferredPayments: [],
    });
    expect(facts.get(own)!.ownPayments).toHaveLength(1);
    expect(facts.get(presented)!.planLocationId).toBe(sedeA);
    expect(facts.get(none)!.planLocationId).toBeNull();
  });

  it('un abono en otra moneda cuenta por su base en la moneda del plan; sin base, null; un abono anulado no sale', async () => {
    const usd = await plan('ACCEPTED', { currency: 'USD' });
    const withBase = await pay(
      usd,
      5_400,
      '2026-05-01T15:00:00.000Z',
      sedeA,
      'VES',
    );
    await pay(usd, 7_200, '2026-05-02T15:00:00.000Z', sedeA, 'VES');
    const voided = await pay(usd, 10, '2026-05-03T15:00:00.000Z', sedeA, 'USD');
    await raw.paymentPlanAmount.create({
      data: {
        tenantId,
        paymentId: withBase,
        treatmentPlanId: usd,
        currency: 'USD',
        amount: 120,
        rateDate: new Date('2026-05-01'),
      },
    });
    await raw.payment.update({
      where: { id: voided },
      data: {
        deletedAt: new Date(),
        voidedAt: new Date(),
        voidedById: userId,
        voidReason: 'Error',
      },
    });

    const facts = await inContext(() => receivables.planCreditFacts([usd]));

    expect(facts.get(usd)!.ownPayments.map((p) => p.planCents)).toEqual([
      12_000,
      null,
    ]);
  });

  const transfer = (source: string, target: string, amountCents: number) =>
    inContext(() =>
      credit.createTransfer({
        sourcePlanId: source,
        targetPlanId: target,
        amountCents,
        currency: 'VES',
        reason: null,
        userId,
        fingerprint: `${source}>${target}>${amountCents}`,
      }),
    );
  const summary = (facts: PlanCreditFacts) => ({
    own: facts.ownPayments.map((p) => p.planCents),
    transferred: facts.transferredPayments.map((p) => p.planCents),
  });

  // DB-076: un traspaso de ida y vuelta (P→Q y Q→P) es un flujo admitido. La
  // recursión debe terminar, y la raíz no cuenta como origen de sí misma.
  it('DB-076: un ciclo de dos planes (P→Q y Q→P) termina y cada plan sale una vez', async () => {
    const p = await plan('ACCEPTED');
    await pay(p, 100, '2026-06-01T15:00:00.000Z', sedeA);
    const q = await plan('ACCEPTED');
    await transfer(p, q, 10_000);
    await transfer(q, p, 4_000);

    const facts = await inContext(() => receivables.planCreditFacts([p, q]));

    expect(summary(facts.get(p)!)).toEqual({ own: [10_000], transferred: [] });
    expect(summary(facts.get(q)!)).toEqual({ own: [], transferred: [10_000] });
  }, 10_000);

  it('DB-076: un ciclo de tres planes (P→Q→R→P) termina y cada plan sale una vez', async () => {
    const p = await plan('ACCEPTED');
    await pay(p, 100, '2026-06-02T15:00:00.000Z', sedeA);
    const q = await plan('ACCEPTED');
    const r = await plan('ACCEPTED');
    await transfer(p, q, 10_000);
    await transfer(q, r, 6_000);
    await transfer(r, p, 2_000);

    const facts = await inContext(() => receivables.planCreditFacts([p, q, r]));

    expect(summary(facts.get(p)!)).toEqual({ own: [10_000], transferred: [] });
    expect(summary(facts.get(q)!)).toEqual({ own: [], transferred: [10_000] });
    expect(summary(facts.get(r)!)).toEqual({ own: [], transferred: [10_000] });
  }, 10_000);

  it('DB-076: un plan al que se llega por varios caminos de traspasos aporta sus abonos una sola vez', async () => {
    const d = await plan('ACCEPTED');
    await pay(d, 300, '2026-06-03T15:00:00.000Z', sedeB);
    const b = await plan('ACCEPTED');
    const c = await plan('ACCEPTED');
    const root = await plan('ACCEPTED');
    await transfer(d, b, 10_000);
    await transfer(d, c, 10_000);
    await transfer(d, root, 5_000);
    await transfer(b, root, 10_000);
    await transfer(c, root, 10_000);

    const facts = await inContext(() => receivables.planCreditFacts([root]));

    expect(summary(facts.get(root)!)).toEqual({
      own: [],
      transferred: [30_000],
    });
  }, 10_000);

  it('otra clínica no ve estos hechos (RLS)', async () => {
    const other = await raw.tenant.create({
      data: { name: 'dx430-int-b', subdomain: 'dx430-int-b' },
    });
    try {
      const any = await plan('ACCEPTED');
      const facts = await tenantContext.run(other.id, undefined, () =>
        receivables.planCreditFacts([any]),
      );
      expect(facts.get(any)).toBeUndefined();
    } finally {
      await raw.tenant.delete({ where: { id: other.id } });
    }
  });
});
