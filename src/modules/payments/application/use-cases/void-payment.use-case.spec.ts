import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ClinicRole, TreatmentPlanStatus } from '@prisma/client';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { LOCATION_NOT_ALLOWED_MESSAGE } from '../../../../shared/tenancy/location-access';
import { VoidPaymentUseCase } from './void-payment.use-case';
import { ListPaymentsUseCase } from './list-payments.use-case';
import { InMemoryPaymentRepository } from './__fixtures__/in-memory-payment.repository';
import { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import { TreatmentPlanDetail } from '../../../treatment-plans/domain/entities/treatment-plan.entity';
import { PLAN_WITHOUT_OPTIONS } from '../../../treatment-plans/application/use-cases/__fixtures__/in-memory-treatment-plan.repository';

// Minimal fake for `GetTreatmentPlanUseCase` -- `ListPaymentsUseCase` now
// resolves the plan first (IMP-3, 404 parity with GET .../balance); this
// spec only cares about void/list interaction, so the fake always
// "finds" the plan.
class FakeGetTreatmentPlanUseCase {
  execute(): Promise<TreatmentPlanDetail> {
    return Promise.resolve({
      id: 'plan-1',
      tenantId: 't1',
      patientId: 'patient-1',
      status: TreatmentPlanStatus.DRAFT,
      currency: 'USD',
      notes: null,
      createdById: null,
      ...PLAN_WITHOUT_OPTIONS,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      acceptance: null,
      items: [],
      total: 0,
    });
  }
}

// 2026-10-16 10:00 en Bogotá (UTC-5).
const NOW = new Date('2026-10-16T15:00:00.000Z');
const clock = (): Date => NOW;

const ADMIN = { userId: 'u-admin', role: ClinicRole.ADMIN };
const RECEPTION = { userId: 'u-recep', role: ClinicRole.RECEPTION };
const REASON = 'Cobro duplicado por error';

describe('VoidPaymentUseCase', () => {
  const context = new TenantContextService();

  it.each([
    ['otra sede, vista consolidada', undefined, ['loc-a', 'loc-c']],
    ['otra sede, cabecera permitida', 'loc-a', ['loc-a']],
    ['ninguna sede permitida', undefined, []],
  ] as const)(
    'rechaza ADMIN restringido: %s sin anular el abono',
    async (_, active, allowed) => {
      const repo = new InMemoryPaymentRepository();
      const payment = repo.seedPayment({ amount: 100, locationId: 'loc-b' });
      const uc = new VoidPaymentUseCase(repo, clock, context);
      await context.run(
        't1',
        active,
        async () => {
          await expect(
            uc.execute({ paymentId: payment.id, reason: REASON, actor: ADMIN }),
          ).rejects.toThrow(LOCATION_NOT_ALLOWED_MESSAGE);
          expect(await repo.findById(payment.id)).not.toBeNull();
          expect(repo.voidAuditOf(payment.id)).toBeNull();
        },
        allowed,
      );
    },
  );

  it.each([
    ['su sede, vista consolidada', undefined, ['loc-b', 'loc-c']],
    ['su sede, otra cabecera permitida', 'loc-c', ['loc-b', 'loc-c']],
    ['ALL', undefined, undefined],
  ] as const)(
    'permite %s según la sede persistida',
    async (_, active, allowed) => {
      const repo = new InMemoryPaymentRepository();
      const payment = repo.seedPayment({ locationId: 'loc-b' });
      const uc = new VoidPaymentUseCase(repo, clock, context);
      await context.run(
        't1',
        active,
        () =>
          uc.execute({ paymentId: payment.id, reason: REASON, actor: ADMIN }),
        allowed,
      );
      expect(await repo.findById(payment.id)).toBeNull();
      expect(repo.voidAuditOf(payment.id)?.voidedById).toBe(ADMIN.userId);
    },
  );
  it('DX-390: una línea de un cobro dividido anula el cobro entero y devuelve las otras líneas', async () => {
    const repo = new InMemoryPaymentRepository();
    const head = repo.seedPayment({ id: 'line-1', amount: 100 });
    repo.seedPayment({ id: 'line-2', amount: 50 });
    repo.seedPayment({ id: 'single', amount: 10 });
    // Las dos líneas del cobro (seedPayment no conoce el cobro).
    const split = { splitId: head.id };
    Object.assign(
      (repo as unknown as { payments: Record<string, unknown>[] }).payments[0],
      { ...split, splitLine: 1 },
    );
    Object.assign(
      (repo as unknown as { payments: Record<string, unknown>[] }).payments[1],
      { ...split, splitLine: 2 },
    );
    const uc = new VoidPaymentUseCase(repo, clock, context);

    const others = await uc.execute({
      paymentId: 'line-2',
      reason: REASON,
      actor: ADMIN,
    });

    expect(others).toEqual(['line-1']);
    expect(repo.voidAuditOf('line-1')?.reason).toBe(REASON);
    expect(repo.voidAuditOf('line-2')?.reason).toBe(REASON);
    expect(repo.voidAuditOf('single')).toBeNull();
    await expect(
      uc.execute({ paymentId: 'single', reason: REASON, actor: ADMIN }),
    ).resolves.toEqual([]);
  });

  it('soft-deletes an existing payment, excluding it from active listings', async () => {
    const repo = new InMemoryPaymentRepository();
    const payment = repo.seedPayment({
      treatmentPlanId: 'plan-1',
      amount: 100,
    });
    const voidUc = new VoidPaymentUseCase(repo, clock, context);
    const listUc = new ListPaymentsUseCase(
      repo,
      new FakeGetTreatmentPlanUseCase() as unknown as GetTreatmentPlanUseCase,
    );

    await voidUc.execute({
      paymentId: payment.id,
      reason: REASON,
      actor: ADMIN,
    });

    const remaining = await listUc.execute('plan-1');
    expect(remaining).toEqual([]);
  });

  it('records who voided it, when and why (SEC-013)', async () => {
    const repo = new InMemoryPaymentRepository();
    const payment = repo.seedPayment({ amount: 100 });
    const uc = new VoidPaymentUseCase(repo, clock, context);

    await uc.execute({ paymentId: payment.id, reason: REASON, actor: ADMIN });

    expect(repo.voidAuditOf(payment.id)).toEqual({
      voidedById: 'u-admin',
      voidedByRole: ClinicRole.ADMIN,
      voidedAt: NOW,
      reason: REASON,
      request: null,
    });
  });

  it('pasa al repositorio desde dónde se anula (DX-215: auditoría de la reapertura del compromiso)', async () => {
    const repo = new InMemoryPaymentRepository();
    const payment = repo.seedPayment({ amount: 100 });
    const uc = new VoidPaymentUseCase(repo, clock, context);
    const request = {
      locationId: 'loc-1',
      requestId: 'req-1',
      ip: '10.0.0.1',
      userAgent: 'jest',
    };

    await uc.execute({
      paymentId: payment.id,
      reason: REASON,
      actor: ADMIN,
      request,
    });

    expect(repo.voidAuditOf(payment.id)).toMatchObject({ request });
  });

  it('throws NotFoundException when the payment is absent', async () => {
    const repo = new InMemoryPaymentRepository();
    const uc = new VoidPaymentUseCase(repo, clock, context);

    await expect(
      uc.execute({ paymentId: 'missing-id', reason: REASON, actor: ADMIN }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFoundException when the payment is already voided', async () => {
    const repo = new InMemoryPaymentRepository();
    const payment = repo.seedPayment({ amount: 100 });
    const uc = new VoidPaymentUseCase(repo, clock, context);

    await uc.execute({ paymentId: payment.id, reason: REASON, actor: ADMIN });

    await expect(
      uc.execute({ paymentId: payment.id, reason: REASON, actor: ADMIN }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('ventana de anulación de recepción', () => {
    it('RECEPTION anula un abono SUYO registrado HOY (día de la sede)', async () => {
      const repo = new InMemoryPaymentRepository();
      const payment = repo.seedPayment({
        createdById: 'u-recep',
        // 08:00 en Bogotá del mismo día.
        createdAt: new Date('2026-10-16T13:00:00.000Z'),
      });
      const uc = new VoidPaymentUseCase(repo, clock, context);

      await uc.execute({
        paymentId: payment.id,
        reason: REASON,
        actor: RECEPTION,
      });

      expect(repo.voidAuditOf(payment.id)?.voidedById).toBe('u-recep');
    });

    it('RECEPTION no anula un abono de OTRO usuario (403) y no lo toca', async () => {
      const repo = new InMemoryPaymentRepository();
      const payment = repo.seedPayment({
        createdById: 'u-otra',
        createdAt: new Date('2026-10-16T13:00:00.000Z'),
      });
      const uc = new VoidPaymentUseCase(repo, clock, context);

      await expect(
        uc.execute({ paymentId: payment.id, reason: REASON, actor: RECEPTION }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(await repo.findById(payment.id)).not.toBeNull();
    });

    it('RECEPTION no anula un abono sin autor conocido (legado)', async () => {
      const repo = new InMemoryPaymentRepository();
      const payment = repo.seedPayment({
        createdById: null,
        createdAt: new Date('2026-10-16T13:00:00.000Z'),
      });
      const uc = new VoidPaymentUseCase(repo, clock, context);

      await expect(
        uc.execute({ paymentId: payment.id, reason: REASON, actor: RECEPTION }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('RECEPTION no anula un abono suyo de OTRO día (403)', async () => {
      const repo = new InMemoryPaymentRepository();
      const payment = repo.seedPayment({
        createdById: 'u-recep',
        createdAt: new Date('2026-10-15T15:00:00.000Z'),
      });
      const uc = new VoidPaymentUseCase(repo, clock, context);

      await expect(
        uc.execute({ paymentId: payment.id, reason: REASON, actor: RECEPTION }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('el "día" es el de la zona de la sede, no el UTC', async () => {
      // 2026-10-16 02:00 UTC = 2026-10-15 21:00 en Bogotá: mismo día UTC que
      // NOW, pero OTRO día en la sede -> 403.
      const repo = new InMemoryPaymentRepository();
      const ayerEnSede = repo.seedPayment({
        createdById: 'u-recep',
        createdAt: new Date('2026-10-16T02:00:00.000Z'),
      });
      const uc = new VoidPaymentUseCase(repo, clock, context);
      await expect(
        uc.execute({
          paymentId: ayerEnSede.id,
          reason: REASON,
          actor: RECEPTION,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Y al revés: en una sede en Madrid (UTC+2) 2026-10-16 01:00 local es
      // el 15 en UTC, pero HOY en la sede -> se puede.
      const madrid = new InMemoryPaymentRepository('Europe/Madrid');
      const hoyEnMadrid = madrid.seedPayment({
        createdById: 'u-recep',
        createdAt: new Date('2026-10-15T23:00:00.000Z'),
      });
      await new VoidPaymentUseCase(madrid, clock, context).execute({
        paymentId: hoyEnMadrid.id,
        reason: REASON,
        actor: RECEPTION,
      });
      expect(madrid.voidAuditOf(hoyEnMadrid.id)).not.toBeNull();
    });

    it('ADMIN anula cualquier abono, de cualquier día y usuario', async () => {
      const repo = new InMemoryPaymentRepository();
      const payment = repo.seedPayment({
        createdById: 'u-otra',
        createdAt: new Date('2026-01-01T15:00:00.000Z'),
      });
      const uc = new VoidPaymentUseCase(repo, clock, context);

      await uc.execute({ paymentId: payment.id, reason: REASON, actor: ADMIN });

      expect(repo.voidAuditOf(payment.id)?.voidedById).toBe('u-admin');
    });
  });
});
