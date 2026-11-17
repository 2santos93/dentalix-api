import { BadRequestException, ConflictException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import {
  AcceptTreatmentPlanUseCase,
  GetPlanQuoteUseCase,
  INSTALLMENT_SIMULATION_STALE,
  INSTALLMENTS_WITH_PARTIAL_MESSAGE,
} from './plan-quote.use-cases';
import {
  InMemoryPlanQuoteRepository,
  quoteSource,
} from './__fixtures__/in-memory-plan-quote.repository';
import { FixedDocumentTypeNamesReader } from '../../../document-type-names/__fixtures__/fixed-document-type-names.reader';
import { referenceCurrencyDigitsCatalog } from '../../../../shared/money/__fixtures__/reference-currency-digits';
import {
  parseInstallmentTerms,
  planInstallmentSchedule,
} from '../../../payment-plans/application/schedule/installment-schedule';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const NOW = new Date('2026-10-16T14:00:00.000Z');
const META = {
  acceptedById: 'user-1',
  role: ClinicRole.DENTIST,
  ipAddress: '10.0.0.1',
  userAgent: 'jest',
};
// Lo cobrable del presupuesto del fixture: (3 500 000 − 350 000) + 180 000.
const TOTAL = 3330000;
const TERMS = {
  downPayment: 330000,
  installmentsCount: 7,
  periodicity: 'MONTHLY' as const,
  startDate: '2026-11-30',
};

function setup(audit?: RecordAuditEventUseCase) {
  const names = new FixedDocumentTypeNamesReader();
  const repo = new InMemoryPlanQuoteRepository();
  repo.add(quoteSource());
  const clock = () => NOW;
  return {
    repo,
    get: new GetPlanQuoteUseCase(repo, clock, names),
    accept: new AcceptTreatmentPlanUseCase(
      repo,
      clock,
      names,
      'current',
      undefined,
      audit,
      referenceCurrencyDigitsCatalog(),
    ),
  };
}

const signing = (contentHash: string, extra: object = {}) => ({
  signerName: 'Ana Pérez',
  signature: `data:image/png;base64,${PNG}`,
  contentHash,
  ...extra,
});

describe('DX-041 · aceptar el presupuesto con un plan de cuotas', () => {
  it('crea el plan de cuotas en la aceptación con las cuotas y fechas de la simulación', async () => {
    const { repo, get, accept } = setup();
    const shown = await get.execute('patient-1', 'plan-1');
    const doc = await accept.execute(
      'patient-1',
      'plan-1',
      signing(shown.contentHash, {
        installmentPlan: { ...TERMS, totalToFinance: TOTAL },
      }),
      META,
    );
    expect(repo.inserted).toHaveLength(1);
    expect(repo.paymentPlans).toHaveLength(1);
    const [created] = repo.paymentPlans;
    expect(doc.paymentPlanId).toBe(created.id);
    // Lo que la simulación habría devuelto con los mismos datos.
    const simulated = planInstallmentSchedule(
      parseInstallmentTerms(TERMS),
      TOTAL,
      2,
    );
    expect(created).toMatchObject({
      treatmentPlanId: 'plan-1',
      patientId: 'patient-1',
      currency: 'USD',
      totalToFinance: TOTAL,
      downPayment: 330000,
      installmentsCount: 7,
      periodicity: 'MONTHLY',
      createdById: 'user-1',
      lockActor: null,
    });
    expect(created.installments).toEqual(simulated.installments);
    const sum =
      created.installments.reduce((s, i) => s + i.amount * 100, 0) +
      created.downPayment * 100;
    expect(Math.round(sum)).toBe(TOTAL * 100);
  });

  it('sin installmentPlan, como siempre: sin plan de cuotas', async () => {
    const { repo, get, accept } = setup();
    const shown = await get.execute('patient-1', 'plan-1');
    const doc = await accept.execute(
      'patient-1',
      'plan-1',
      signing(shown.contentHash),
      META,
    );
    expect(doc.paymentPlanId).toBeNull();
    expect(repo.paymentPlans).toHaveLength(0);
  });

  it('si el saldo no es el simulado: 409 INSTALLMENT_SIMULATION_STALE y no se acepta nada', async () => {
    const { repo, get, accept } = setup();
    const shown = await get.execute('patient-1', 'plan-1');
    const error: unknown = await accept
      .execute(
        'patient-1',
        'plan-1',
        signing(shown.contentHash, {
          installmentPlan: { ...TERMS, totalToFinance: TOTAL - 0.01 },
        }),
        META,
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: INSTALLMENT_SIMULATION_STALE,
    });
    expect(repo.inserted).toHaveLength(0);
    expect(repo.paymentPlans).toHaveLength(0);
    expect(repo.sources.get('plan-1')!.acceptance).toBeNull();
  });

  it('condiciones no válidas: 400 antes de tocar el plan', async () => {
    const { repo, get, accept } = setup();
    const shown = await get.execute('patient-1', 'plan-1');
    await expect(
      accept.execute(
        'patient-1',
        'plan-1',
        signing(shown.contentHash, {
          installmentPlan: {
            ...TERMS,
            installmentsCount: 601,
            totalToFinance: TOTAL,
          },
        }),
        META,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      accept.execute(
        'patient-1',
        'plan-1',
        signing(shown.contentHash, {
          installmentPlan: {
            ...TERMS,
            downPayment: TOTAL + 1,
            totalToFinance: TOTAL,
          },
        }),
        META,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.inserted).toHaveLength(0);
  });

  it('no se combina con una aceptación parcial (400)', async () => {
    const { get, accept } = setup();
    const shown = await get.execute('patient-1', 'plan-1');
    await expect(
      accept.execute(
        'patient-1',
        'plan-1',
        signing(shown.contentHash, {
          partial: { itemIds: ['item-1'] },
          installmentPlan: { ...TERMS, totalToFinance: TOTAL },
        }),
        META,
      ),
    ).rejects.toThrow(INSTALLMENTS_WITH_PARTIAL_MESSAGE);
  });

  it('el alta del plan de cuotas deja su propio evento CREATE PAYMENT_PLAN', async () => {
    const events: unknown[] = [];
    const audit = {
      record: (draft: unknown) => {
        events.push(draft);
        return Promise.resolve();
      },
    } as unknown as RecordAuditEventUseCase;
    const { get, accept } = setup(audit);
    const shown = await get.execute('patient-1', 'plan-1');
    const auditCtx = {
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      actor: { userId: 'user-1', role: ClinicRole.DENTIST },
      requestId: 'req-1',
      ip: '10.0.0.1',
      userAgent: 'jest',
    };
    const doc = await accept.execute(
      'patient-1',
      'plan-1',
      signing(shown.contentHash, {
        installmentPlan: { ...TERMS, totalToFinance: TOTAL },
      }),
      { ...META, audit: auditCtx },
    );
    expect(events).toEqual([
      {
        tenantId: 'tenant-1',
        locationId: 'loc-1',
        actor: { kind: 'user', userId: 'user-1', role: ClinicRole.DENTIST },
        action: 'CREATE',
        resourceType: 'PAYMENT_PLAN',
        resourceId: doc.paymentPlanId,
        patient: { kind: 'patient', id: 'patient-1' },
        requestId: 'req-1',
        ip: '10.0.0.1',
        userAgent: 'jest',
        metadata: {
          reason: 'PLAN_ACCEPTED_WITH_INSTALLMENTS',
          params: { treatmentPlanId: 'plan-1' },
        },
      },
    ]);
  });
});
