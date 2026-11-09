import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  type HttpException,
} from '@nestjs/common';
import {
  ClinicRole,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
} from '@prisma/client';
import { FixedDocumentTypeNamesReader } from '../../../document-type-names/__fixtures__/fixed-document-type-names.reader';
import { QUOTE_EXPIRED_CODE } from '../../domain/expired-quote-acceptance';
import {
  PARTIAL_ALL_CHOSEN_MESSAGE,
  PARTIAL_PAYMENTS_MESSAGE,
  PARTIAL_PLAN_NOT_PRESENTED_CODE,
} from '../../domain/partial-acceptance';
import { computeQuoteHash } from '../../domain/plan-quote';
import type { RepricingSubject } from '../../domain/ports/plan-repricing-repository.port';
import type { PlanQuoteSource } from '../../domain/ports/plan-quote-repository.port';
import type { ItemPriceState, Repricing } from '../repricing';
import {
  InMemoryPlanQuoteRepository,
  quoteSource,
} from './__fixtures__/in-memory-plan-quote.repository';
import {
  AcceptTreatmentPlanUseCase,
  GetPlanQuoteUseCase,
  PreviewPartialAcceptanceUseCase,
  QUOTE_CHANGED_MESSAGE,
  type AcceptTreatmentPlanInput,
} from './plan-quote.use-cases';
import type {
  AcceptanceRepricer,
  AcceptanceRepricingContext,
} from './plan-repricing.use-cases';

// DX-417: aceptar en la clínica solo una parte del presupuesto.

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// 16/10/2026 10:00 en Caracas (UTC-4).
const NOW = new Date('2026-10-16T14:00:00.000Z');
const META = {
  acceptedById: 'user-1',
  role: ClinicRole.DENTIST,
  ipAddress: '10.0.0.1',
  userAgent: 'jest',
};
const PREVIEW_HASH = 'c'.repeat(64);
const RENEWED = { issuedOn: '2026-10-16', validUntil: '2026-11-15' };

let names: FixedDocumentTypeNamesReader;
beforeEach(() => {
  names = new FixedDocumentTypeNamesReader();
});

/** Plan presentado en VES con tres ítems; vence el 20/10 (vigente el 16/10). */
function presented(validUntil = '2026-10-20'): PlanQuoteSource {
  const base = quoteSource();
  return quoteSource({
    plan: {
      ...base.plan,
      currency: 'VES',
      status: TreatmentPlanStatus.PRESENTED,
      quoteIssuedOn: '2026-09-20',
      quoteValidUntil: validUntil,
      presentedLocationId: 'loc-1',
    },
    items: [
      ...base.items,
      {
        ...base.items[1],
        id: 'item-3',
        toothNumber: '26',
        procedure: 'Endodoncia',
        price: 925000.5,
        discount: 25000.25,
      },
    ],
  });
}

function priceState(price: number, discount: number): ItemPriceState {
  return {
    catalogPrice: price,
    basePrice: price,
    catalogCurrency: 'VES',
    priceSource: 'CATALOG',
    agreementId: null,
    agreementName: null,
    pricingLocationId: 'loc-1',
    reference: {
      referenceCurrency: 'VES',
      referencePriceInPlan: price,
      basePriceInPlan: price,
      referenceRate: null,
    },
    price,
    discount,
    discountReason: null,
    discountReasonNote: null,
    discountById: null,
    discountAt: null,
    discountLocationId: null,
  };
}

/** Recotiza TODO: cada ítem sube un 10 %, sin descuento. */
function repricing(source: PlanQuoteSource): Repricing {
  return {
    planId: source.plan.id,
    currency: 'VES',
    lines: source.items.map((item) => ({
      itemId: item.id,
      catalogItemId: `cat-${item.id}`,
      toothNumber: item.toothNumber,
      before: priceState(item.price, item.discount),
      after: priceState(Math.round(item.price * 110) / 100, 0),
      changed: true,
    })),
    skipped: [],
    rate: null,
    previousValidity: {
      issuedOn: source.plan.quoteIssuedOn!,
      validUntil: source.plan.quoteValidUntil!,
    },
    validityRenewed: true,
    validityNote: null,
    validity: RENEWED,
    totals: { before: 0, after: 0 },
    previewHash: PREVIEW_HASH,
  };
}

function setup(source: PlanQuoteSource = presented()) {
  const repo = new InMemoryPlanQuoteRepository();
  repo.add(source);
  repo.subjectFor = (s) => s as unknown as RepricingSubject;
  const clock = () => NOW;
  const repricer = {
    read: () => Promise.resolve({} as AcceptanceRepricingContext),
    decide: (_context: AcceptanceRepricingContext, subject: RepricingSubject) =>
      repricing(subject as unknown as PlanQuoteSource),
  } as unknown as AcceptanceRepricer;
  return {
    repo,
    get: new GetPlanQuoteUseCase(repo, clock, names),
    accept: new AcceptTreatmentPlanUseCase(
      repo,
      clock,
      names,
      'current',
      repricer,
    ),
    preview: new PreviewPartialAcceptanceUseCase(repo, clock, names, repricer),
  };
}

async function rejection(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('no lanzó');
}

function signing(
  contentHash: string,
  extra: Partial<AcceptTreatmentPlanInput> = {},
): AcceptTreatmentPlanInput {
  return { signerName: 'Ana Pérez', signature: PNG, contentHash, ...extra };
}

describe('PreviewPartialAcceptanceUseCase (DX-417)', () => {
  it('compone lo aceptado (con su hash), lo pendiente y los totales del plan entero', async () => {
    const ctx = setup();
    const preview = await ctx.preview.execute(
      'patient-1',
      'plan-1',
      { itemIds: ['ITEM-3'.toLowerCase(), 'item-1'] },
      { userId: 'user-1', role: ClinicRole.DENTIST },
    );
    expect(preview.accepted.items.map((i) => i.id)).toEqual([
      'item-1',
      'item-3',
    ]);
    expect(preview.accepted.contentHash).toBe(
      computeQuoteHash(preview.accepted),
    );
    expect(preview.accepted.acceptance).toBeNull();
    expect(preview.accepted.validUntil).toBe('2026-10-20');
    expect(preview.pending.items.map((i) => i.id)).toEqual(['item-2']);
    expect(preview.accepted.totals[0]).toMatchObject({
      currency: 'VES',
      net: 3150000 + 900000.25,
    });
    expect(preview.pending.totals).toEqual([
      {
        currency: 'VES',
        gross: 180000,
        discount: 0,
        net: 180000,
        agreementSaving: 0,
      },
    ]);
    expect(preview.original.totals[0].net).toBe(3150000 + 180000 + 900000.25);
    expect(preview.repricing).toBeNull();
    // No escribe nada.
    expect(ctx.repo.inserted).toHaveLength(0);
    expect(ctx.repo.pendingPlans).toHaveLength(0);
  });

  it('las reglas de la partición salen como 400/404/409 en español', async () => {
    const ctx = setup();
    const actor = { userId: 'user-1', role: ClinicRole.DENTIST };
    const all = await rejection(
      ctx.preview.execute(
        'patient-1',
        'plan-1',
        { itemIds: ['item-1', 'item-2', 'item-3'] },
        actor,
      ),
    );
    expect(all).toBeInstanceOf(BadRequestException);
    expect(all.message).toBe(PARTIAL_ALL_CHOSEN_MESSAGE);
    const foreign = await rejection(
      ctx.preview.execute(
        'patient-1',
        'plan-1',
        { itemIds: ['item-9'] },
        actor,
      ),
    );
    expect(foreign).toBeInstanceOf(NotFoundException);
    ctx.repo.facts = { ...ctx.repo.facts, hasLivePayments: true };
    const paid = await rejection(
      ctx.preview.execute(
        'patient-1',
        'plan-1',
        { itemIds: ['item-1'] },
        actor,
      ),
    );
    expect(paid).toBeInstanceOf(ConflictException);
    expect(paid.message).toBe(PARTIAL_PAYMENTS_MESSAGE);
  });

  it('un borrador: 409 con su código', async () => {
    const source = presented();
    const ctx = setup({
      ...source,
      plan: { ...source.plan, status: TreatmentPlanStatus.DRAFT },
    });
    const error = await rejection(
      ctx.preview.execute(
        'patient-1',
        'plan-1',
        { itemIds: ['item-1'] },
        { userId: 'user-1', role: ClinicRole.DENTIST },
      ),
    );
    expect(error.getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: PARTIAL_PLAN_NOT_PRESENTED_CODE,
      message: 'Solo un presupuesto presentado se acepta en parte.',
    });
  });

  it('404 si el plan no es de este paciente', async () => {
    const ctx = setup();
    await expect(
      ctx.preview.execute(
        'patient-2',
        'plan-1',
        { itemIds: ['item-1'] },
        { userId: 'user-1', role: ClinicRole.DENTIST },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AcceptTreatmentPlanUseCase con `partial` (DX-417)', () => {
  it('firma lo aceptado y deja el resto en un plan pendiente, con su total', async () => {
    const ctx = setup();
    const preview = await ctx.preview.execute(
      'patient-1',
      'plan-1',
      { itemIds: ['item-1', 'item-3'] },
      { userId: 'user-1', role: ClinicRole.DENTIST },
    );
    const doc = await ctx.accept.execute(
      'patient-1',
      'plan-1',
      signing(preview.accepted.contentHash, {
        partial: { itemIds: ['item-1', 'item-3'] },
      }),
      META,
    );
    expect(doc.planStatus).toBe(TreatmentPlanStatus.ACCEPTED);
    expect(doc.contentHash).toBe(preview.accepted.contentHash);
    expect(doc.items.map((i) => i.id)).toEqual(['item-1', 'item-3']);
    expect(doc.acceptance).toMatchObject({
      integrityOk: true,
      pendingPlanId: 'pending-1',
      pendingItemIds: ['item-2'],
      pendingTotal: 180000,
    });
    expect(ctx.repo.inserted[0].partial).toEqual({
      pendingItemIds: ['item-2'],
      pendingTotal: 180000,
    });
    const [pending] = ctx.repo.pendingPlans;
    expect(pending.plan.status).toBe(TreatmentPlanStatus.PRESENTED);
    expect(pending.plan.quoteValidUntil).toBe('2026-10-20');
    expect(pending.items.map((i) => i.id)).toEqual(['item-2']);
  });

  it('con el hash del presupuesto ENTERO: 409 QUOTE_CHANGED y nada se escribe', async () => {
    const ctx = setup();
    const whole = await ctx.get.execute('patient-1', 'plan-1');
    const error = await rejection(
      ctx.accept.execute(
        'patient-1',
        'plan-1',
        signing(whole.contentHash, { partial: { itemIds: ['item-1'] } }),
        META,
      ),
    );
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toBe(QUOTE_CHANGED_MESSAGE);
    expect(ctx.repo.inserted).toHaveLength(0);
    expect(ctx.repo.pendingPlans).toHaveLength(0);
  });

  it('un ítem ya realizado dejado fuera: 400 y nada se escribe', async () => {
    const ctx = setup();
    ctx.repo.itemStatuses.set('item-2', TreatmentPlanItemStatus.DONE);
    const error = await rejection(
      ctx.accept.execute(
        'patient-1',
        'plan-1',
        signing('a'.repeat(64), { partial: { itemIds: ['item-1'] } }),
        META,
      ),
    );
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toBe(
      'Los procedimientos ya aceptados o realizados forman parte de lo aceptado.',
    );
    expect(ctx.repo.inserted).toHaveLength(0);
  });

  it('red: si lo releído tras mover no es lo firmado, lanza y nada se escribe', async () => {
    const ctx = setup();
    const preview = await ctx.preview.execute(
      'patient-1',
      'plan-1',
      { itemIds: ['item-1'] },
      { userId: 'user-1', role: ClinicRole.DENTIST },
    );
    ctx.repo.tamperAfterMove = (s) => ({
      ...s,
      items: s.items.map((i) => ({ ...i, price: i.price + 1 })),
    });
    await expect(
      ctx.accept.execute(
        'patient-1',
        'plan-1',
        signing(preview.accepted.contentHash, {
          partial: { itemIds: ['item-1'] },
        }),
        META,
      ),
    ).rejects.toThrow('el presupuesto releído no es el que se firma');
    expect(ctx.repo.inserted).toHaveLength(0);
    expect(ctx.repo.pendingPlans).toHaveLength(0);
  });

  describe('con el presupuesto vencido', () => {
    it('sin elegir cómo: 409 QUOTE_EXPIRED (se decide antes de partir)', async () => {
      const ctx = setup(presented('2026-10-01'));
      const preview = await ctx.preview.execute(
        'patient-1',
        'plan-1',
        { itemIds: ['item-1'] },
        { userId: 'user-1', role: ClinicRole.DENTIST },
      );
      const error = await rejection(
        ctx.accept.execute(
          'patient-1',
          'plan-1',
          signing(preview.accepted.contentHash, {
            partial: { itemIds: ['item-1'] },
          }),
          META,
        ),
      );
      expect(error.getResponse()).toMatchObject({ code: QUOTE_EXPIRED_CODE });
      expect(ctx.repo.pendingPlans).toHaveLength(0);
    });

    it('ORIGINAL_PRICES: firma lo aceptado con los precios viejos y el pendiente nace vencido', async () => {
      const ctx = setup(presented('2026-10-01'));
      const preview = await ctx.preview.execute(
        'patient-1',
        'plan-1',
        { itemIds: ['item-1'] },
        { userId: 'user-1', role: ClinicRole.DENTIST },
      );
      const doc = await ctx.accept.execute(
        'patient-1',
        'plan-1',
        signing(preview.accepted.contentHash, {
          partial: { itemIds: ['item-1'] },
          expired: { mode: 'ORIGINAL_PRICES', reason: 'LOYALTY' },
        }),
        META,
      );
      expect(doc.acceptance).toMatchObject({
        expiredMode: 'ORIGINAL_PRICES',
        expiredReason: 'LOYALTY',
        pendingItemIds: ['item-2', 'item-3'],
        pendingTotal: 180000 + 900000.25,
      });
      expect(ctx.repo.pendingPlans[0].plan.quoteValidUntil).toBe('2026-10-01');
    });

    it('REPRICE: recotiza TODO el plan, parte después y el pendiente hereda la validez nueva', async () => {
      const ctx = setup(presented('2026-10-01'));
      const actor = { userId: 'user-1', role: ClinicRole.DENTIST };
      const preview = await ctx.preview.execute(
        'patient-1',
        'plan-1',
        { itemIds: ['item-1'], reprice: true },
        actor,
      );
      expect(preview.repricing?.previewHash).toBe(PREVIEW_HASH);
      expect(preview.accepted.items[0].unitPrice).toBe(3850000);
      expect(preview.pending.items.map((i) => i.unitPrice)).toEqual([
        198000, 1017500.55,
      ]);
      // La vista previa no deja nada escrito.
      expect(ctx.repo.repricings).toHaveLength(0);

      const doc = await ctx.accept.execute(
        'patient-1',
        'plan-1',
        signing(preview.accepted.contentHash, {
          partial: { itemIds: ['item-1'] },
          expired: { mode: 'REPRICE', repricePreviewHash: PREVIEW_HASH },
        }),
        META,
      );
      expect(doc.contentHash).toBe(preview.accepted.contentHash);
      expect(doc.validUntil).toBe(RENEWED.validUntil);
      expect(doc.acceptance).toMatchObject({
        expiredMode: 'REPRICE',
        quoteValidUntil: '2026-10-01',
        pendingTotal: 198000 + 1017500.55,
      });
      expect(ctx.repo.repricings).toHaveLength(1);
      const [pending] = ctx.repo.pendingPlans;
      expect(pending.plan.quoteValidUntil).toBe(RENEWED.validUntil);
      expect(pending.items.map((i) => i.price)).toEqual([198000, 1017500.55]);
    });

    it('REPRICE con un presupuesto no vencido: 400 también en la vista previa', async () => {
      const ctx = setup();
      await expect(
        ctx.preview.execute(
          'patient-1',
          'plan-1',
          { itemIds: ['item-1'], reprice: true },
          { userId: 'user-1', role: ClinicRole.DENTIST },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
