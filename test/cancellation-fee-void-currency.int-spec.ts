import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  registerClinic,
  resetDatabase,
  type Clinic,
} from './support/e2e-fixtures';
import { CANCELLATION_FEE_MESSAGES } from '../src/modules/cancellation-fees/domain/cancellation-fee';
import { civilDateIn } from '../src/shared/time/civil-day';

// DX-382 (BE-046) contra Postgres: anular un cargo (SEC-050) compara lo
// cobrado en la MONEDA DEL PLAN, con la base de imputación de cada abono
// (DX-051, convertida con la tasa que congeló, DX-375), no la suma bruta de
// importes en monedas mezcladas. Los tres escenarios en dos clínicas, una con
// la fuente automática y otra con la manual (DX-374), con la misma tasa del
// día (1 USD = 4.000 COP): mismo resultado, y ninguna ve ni mueve los cargos
// de la otra. EXCHANGE_APP_ID está vacío en .env.test: el proveedor no se
// llama nunca (snapshot de hoy con COP y sin EUR).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const ZONE = 'America/Bogota';
const TODAY = civilDateIn(new Date(), ZONE);
const HOUR = 3_600_000;

interface FeeView {
  status: string;
  fee: { planId: string | null; planItemId: string | null } | null;
}

interface Setup {
  clinic: Clinic;
  location: string;
  /** Versión de la política en COP (sugerido 100.000) y en USD (sugerido 50). */
  copVersion: string;
  usdVersion: string;
}

describe('anular un cargo compara en la moneda del plan (DX-382, int)', () => {
  let app: INestApplication<App>;
  const setups = new Map<'AUTOMATIC' | 'MANUAL', Setup>();
  let seq = 0;

  const as = (req: request.Test, clinic: Clinic) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`);
  const post = (clinic: Clinic, path: string, body: object = {}) =>
    as(request(app.getHttpServer()).post(`/api/v1${path}`), clinic).send(body);

  async function policyVersion(
    clinic: Clinic,
    location: string,
    body: object,
  ): Promise<string> {
    return (
      (
        await post(clinic, `/locations/${location}/cancellation-policy`, {
          noticeHours: 24,
          ...body,
        }).expect(201)
      ).body as { id: string }
    ).id;
  }

  async function setup(
    tag: string,
    source: 'AUTOMATIC' | 'MANUAL',
  ): Promise<Setup> {
    const clinic = await registerClinic(app, `dx382-${tag}`);
    const location = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
      })
    ).id;
    if (source === 'MANUAL') {
      await as(
        request(app.getHttpServer()).put('/api/v1/exchange/settings'),
        clinic,
      )
        .send({ source })
        .expect(200);
      await post(clinic, '/exchange/manual-rates', {
        date: TODAY,
        currency: 'COP',
        rate: 4000,
      }).expect(201);
    }
    const copVersion = await policyVersion(clinic, location, {
      suggestedFee: 100000,
      currency: 'COP',
    });
    const usdVersion = await policyVersion(clinic, location, {
      suggestedFee: 50,
      currency: 'USD',
    });
    return { clinic, location, copVersion, usdVersion };
  }

  async function patient(s: Setup): Promise<string> {
    return (
      await raw.patient.create({
        data: {
          tenantId: s.clinic.tenantId,
          firstName: 'Ana',
          lastName: `Moneda ${++seq}`,
        },
      })
    ).id;
  }

  /** Inasistencia con la versión comunicada y su cargo generado. */
  async function charge(
    s: Setup,
    patientId: string,
    policyVersionId: string,
    amount: number,
  ): Promise<{ appointmentId: string; planId: string; itemId: string }> {
    const start = new Date(Date.now() - (++seq * 2 + 24) * HOUR);
    const appointmentId = (
      await raw.appointment.create({
        data: {
          tenantId: s.clinic.tenantId,
          locationId: s.location,
          patientId,
          providerId: randomUUID(),
          start,
          end: new Date(start.getTime() + 30 * 60_000),
          status: 'NO_SHOW',
          noShowMarkedAt: new Date(),
          policyVersionId,
        },
      })
    ).id;
    const view = (
      await post(s.clinic, `/appointments/${appointmentId}/cancellation-fee`, {
        amount,
      }).expect(201)
    ).body as FeeView;
    return {
      appointmentId,
      planId: view.fee!.planId!,
      itemId: view.fee!.planItemId!,
    };
  }

  async function pay(
    s: Setup,
    planId: string,
    amount: number,
    currency: string,
  ): Promise<{ id: string; exchangeRateStatus: string }> {
    return (
      await post(s.clinic, `/treatment-plans/${planId}/payments`, {
        amount,
        currency,
        paidAt: new Date(Date.now() - 60_000).toISOString(),
        method: 'CASH',
      }).expect(201)
    ).body as { id: string; exchangeRateStatus: string };
  }

  const voidFee = (s: Setup, appointmentId: string) =>
    post(s.clinic, `/appointments/${appointmentId}/cancellation-fee/void`, {
      reason: 'Error al generar',
    });

  async function state(appointmentId: string, itemId: string) {
    const fee = await raw.cancellationFee.findFirstOrThrow({
      where: { appointmentId },
      select: { voidedAt: true },
    });
    const item = await raw.treatmentPlanItem.findUniqueOrThrow({
      where: { id: itemId },
      select: { deletedAt: true },
    });
    return { voided: fee.voidedAt !== null, removed: item.deletedAt !== null };
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({ where: { date: TODAY } });
    await raw.exchangeRateSnapshot.createMany({
      data: [
        { date: TODAY, currency: 'COP', rate: 4000 },
        { date: TODAY, currency: 'VES', rate: 36.5 },
      ],
    });
    setups.set('AUTOMATIC', await setup('auto', 'AUTOMATIC'));
    setups.set('MANUAL', await setup('manual', 'MANUAL'));
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({ where: { date: TODAY } });
    await raw.$disconnect();
  });

  describe.each(['AUTOMATIC', 'MANUAL'] as const)('fuente %s', (source) => {
    const s = () => setups.get(source)!;

    it('plan COP con dos cargos y un abono de 50 USD que cubre ambos: anular uno es 409 (ya cobrado) y nada cambia', async () => {
      const p = await patient(s());
      const first = await charge(s(), p, s().copVersion, 100000);
      const second = await charge(s(), p, s().copVersion, 80000);
      expect(second.planId).toBe(first.planId);
      const payment = await pay(s(), first.planId, 50, 'USD');
      expect(payment.exchangeRateStatus).toBe('FROZEN');
      // La base de DX-051 está en la moneda del plan: 50 × 4.000.
      const base = await raw.paymentPlanAmount.findUniqueOrThrow({
        where: { paymentId: payment.id },
      });
      expect(base.currency).toBe('COP');
      expect(base.amount.toNumber()).toBe(200000);

      // Antes (BE-046): 50 > 100.000 era falso y el cargo se anulaba.
      for (const fee of [second, first]) {
        const res = await voidFee(s(), fee.appointmentId).expect(409);
        expect((res.body as { message: string }).message).toBe(
          CANCELLATION_FEE_MESSAGES.voidPaid,
        );
        await expect(state(fee.appointmentId, fee.itemId)).resolves.toEqual({
          voided: false,
          removed: false,
        });
      }
    });

    it('plan USD con un abono de 40.000 COP que cubre la mitad: la anulación pasa (201, el contrato de «Anular cargo»)', async () => {
      const p = await patient(s());
      const small = await charge(s(), p, s().usdVersion, 20);
      const big = await charge(s(), p, s().usdVersion, 30);
      expect(big.planId).toBe(small.planId);
      const payment = await pay(s(), small.planId, 40000, 'COP');
      expect(payment.exchangeRateStatus).toBe('FROZEN');
      const base = await raw.paymentPlanAmount.findUniqueOrThrow({
        where: { paymentId: payment.id },
      });
      expect(base.currency).toBe('USD');
      expect(base.amount.toNumber()).toBe(10);

      // Antes (BE-046): 40.000 > 30 bloqueaba la anulación.
      await voidFee(s(), small.appointmentId).expect(201);
      await expect(state(small.appointmentId, small.itemId)).resolves.toEqual({
        voided: true,
        removed: true,
      });
      // Queda el de 30 con 10 cobrados: el otro tampoco está cubierto.
      await expect(state(big.appointmentId, big.itemId)).resolves.toEqual({
        voided: false,
        removed: false,
      });
    });

    it('con un abono sin base («sin tasa») la anulación es 409 con el mensaje de abonos sin convertir', async () => {
      const p = await patient(s());
      const fee = await charge(s(), p, s().copVersion, 100000);
      // Sin tasa EUR de hoy (ni en el snapshot ni manual): se guarda sin base.
      const payment = await pay(s(), fee.planId, 1, 'EUR');
      expect(payment.exchangeRateStatus).toBe('MISSING');
      await expect(
        raw.paymentPlanAmount.count({ where: { paymentId: payment.id } }),
      ).resolves.toBe(0);

      const res = await voidFee(s(), fee.appointmentId).expect(409);
      expect((res.body as { message: string }).message).toBe(
        'Hay abonos sin convertir; registra la tasa del día antes de anular',
      );
      await expect(state(fee.appointmentId, fee.itemId)).resolves.toEqual({
        voided: false,
        removed: false,
      });

      // Anulado el abono sin tasa, el cargo (sin nada cobrado) se anula.
      await as(
        request(app.getHttpServer()).delete(`/api/v1/payments/${payment.id}`),
        s().clinic,
      )
        .send({ reason: 'Moneda equivocada' })
        .expect(200);
      await voidFee(s(), fee.appointmentId).expect(201);
    });
  });

  it('una clínica no ve ni afecta los cargos de la otra', async () => {
    const auto = setups.get('AUTOMATIC')!;
    const manual = setups.get('MANUAL')!;
    const p = await patient(auto);
    const fee = await charge(auto, p, auto.copVersion, 100000);
    await pay(auto, fee.planId, 50, 'USD');

    // Desde la otra clínica: 404 al anular y al cobrar en su plan.
    await voidFee(manual, fee.appointmentId).expect(404);
    await post(manual.clinic, `/treatment-plans/${fee.planId}/payments`, {
      amount: 1,
      currency: 'EUR',
      paidAt: new Date().toISOString(),
      method: 'CASH',
    }).expect(404);
    await expect(state(fee.appointmentId, fee.itemId)).resolves.toEqual({
      voided: false,
      removed: false,
    });

    // Los abonos sin tasa de la otra clínica no cuentan aquí: «ya cobrado»,
    // no «sin convertir».
    const q = await patient(manual);
    const other = await charge(manual, q, manual.copVersion, 100000);
    await pay(manual, other.planId, 1, 'EUR');
    const res = await voidFee(auto, fee.appointmentId).expect(409);
    expect((res.body as { message: string }).message).toBe(
      CANCELLATION_FEE_MESSAGES.voidPaid,
    );
  });
});
