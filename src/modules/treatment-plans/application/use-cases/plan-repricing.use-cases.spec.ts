import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CatalogKind,
  ExchangeRateSource,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
} from '@prisma/client';
import { referenceCurrencyDigitsCatalog } from '../../../../shared/money/__fixtures__/reference-currency-digits';
import { IDEMPOTENCY_KEY_INVALID_MESSAGE } from '../../../../shared/validation/idempotency-key';
import type { DentalCatalogItem } from '../../../dental-catalog/domain/entities/dental-catalog-item.entity';
import type { DentalCatalogRepository } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import type { TreatmentPlanWithItems } from '../../domain/entities/treatment-plan.entity';
import type { PlanQuoteZones } from '../../domain/ports/plan-quote-zones.port';
import type {
  ReferenceRateLookup,
  ReferenceRateSource,
} from '../../domain/ports/reference-rate-source.port';
import type { QuoteSettingsRepository } from '../../domain/ports/quote-settings-repository.port';
import {
  REPRICE_NOTHING_CODE,
  REPRICE_PAYMENTS_MESSAGE,
  REPRICE_STALE_CODE,
} from '../repricing';
import {
  ADMIN_ACTOR,
  DENTIST_ACTOR,
  testDiscountPolicy,
} from './__fixtures__/discount-fixtures';
import { catalogPricing } from './__fixtures__/catalog-pricing-source';
import { InMemoryPlanRepricingRepository } from './__fixtures__/in-memory-plan-repricing.repository';
import { InMemoryTreatmentPlanRepository } from './__fixtures__/in-memory-treatment-plan.repository';
import { AddTreatmentPlanItemUseCase } from './add-treatment-plan-item.use-case';
import {
  ApplyPlanRepricingUseCase,
  PreviewPlanRepricingUseCase,
  REPRICE_IDEMPOTENCY_KEY_REQUIRED_MESSAGE,
  REPRICE_IDEMPOTENCY_KEY_REUSED_CODE,
  RepricingContextReader,
  repricingRequestFingerprint,
} from './plan-repricing.use-cases';

// 9/11/2026 15:00 UTC = 11:00 en Caracas.
const NOW = new Date('2026-11-09T15:00:00.000Z');
const CLOCK = () => NOW;
const KEY = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const OTHER_KEY = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

function catalogItem(
  id: string,
  overrides: Partial<DentalCatalogItem> = {},
): DentalCatalogItem {
  return {
    id,
    tenantId: 't1',
    code: id.toUpperCase(),
    category: 'Endodoncia',
    kind: CatalogKind.PROCEDURE,
    labelEs: id,
    labelEn: null,
    labelPt: null,
    color: '#FFFFFF',
    defaultPrice: 100,
    allowDiscount: true,
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function rates(toPerBase: number | null): ReferenceRateSource & {
  calls: number;
  set(next: number | null): void;
} {
  let current = toPerBase;
  const source = {
    calls: 0,
    set(next: number | null) {
      current = next;
    },
    rateFor(from: string): Promise<ReferenceRateLookup> {
      source.calls += 1;
      return Promise.resolve(
        current === null
          ? { kind: 'missing', currency: from, date: null, dateLabel: null }
          : {
              kind: 'rate',
              rate: {
                fromPerBase: 1,
                toPerBase: current,
                source: ExchangeRateSource.MANUAL,
                rateDate: '2026-11-09',
              },
              toDigits: 2,
            },
      );
    },
  };
  return source;
}

function setup(opts: { zone?: string | null; rate?: number | null } = {}) {
  const items = new Map<string, DentalCatalogItem>([
    ['endo', catalogItem('endo')],
    ['xray', catalogItem('xray', { defaultPrice: 40 })],
  ]);
  const catalog = {
    findById: (id: string) => Promise.resolve(items.get(id) ?? null),
  } as unknown as DentalCatalogRepository;
  // El catálogo en USD y el plan en VES: el precio vigente sale con la tasa.
  const pricing = catalogPricing(catalog, { catalogCurrency: 'USD' });
  const rateSource = rates(opts.rate === undefined ? 40 : opts.rate);
  const zones: PlanQuoteZones = {
    zonesFor: () =>
      Promise.resolve(() =>
        opts.zone === undefined ? 'America/Caracas' : opts.zone,
      ),
  };
  let validityDays = 30;
  const settings = {
    get: () => Promise.resolve({ validityDays }),
  } as unknown as QuoteSettingsRepository;
  const reader = new RepricingContextReader(
    pricing,
    testDiscountPolicy(),
    CLOCK,
    referenceCurrencyDigitsCatalog(),
    settings,
    zones,
    rateSource,
  );
  const repo = new InMemoryPlanRepricingRepository();
  const plans = new InMemoryTreatmentPlanRepository();
  plans.seedPlan({
    id: 'plan-1',
    patientId: 'p1',
    currency: 'VES',
    status: TreatmentPlanStatus.PRESENTED,
  });
  const add = new AddTreatmentPlanItemUseCase(
    plans,
    pricing,
    testDiscountPolicy(),
    CLOCK,
    rateSource,
  );
  return {
    repo,
    plans,
    add,
    items,
    rateSource,
    setDays: (days: number) => {
      validityDays = days;
    },
    preview: new PreviewPlanRepricingUseCase(repo, reader),
    apply: new ApplyPlanRepricingUseCase(repo, reader),
  };
}

/** Da de alta los ítems con la tasa de hoy (36) y siembra el plan en el repo. */
async function seededPlan(
  ctx: ReturnType<typeof setup>,
  catalogItemIds: string[] = ['endo', 'xray'],
  rateAtAdd = 36,
): Promise<TreatmentPlanWithItems> {
  ctx.rateSource.set(rateAtAdd);
  for (const catalogItemId of catalogItemIds) {
    await ctx.add.execute(
      'plan-1',
      { toothNumber: '11', catalogItemId },
      ADMIN_ACTOR,
    );
  }
  const plan = await ctx.plans.findPlanById('plan-1');
  if (!plan) throw new Error('sin plan');
  plan.quoteIssuedOn = '2026-09-01';
  plan.quoteValidUntil = '2026-10-01';
  ctx.repo.seed(plan);
  return plan;
}

describe('Recotizar un plan (DX-379 porción B)', () => {
  it('un ítem recién dado de alta no cambia al recotizar con la misma tasa: vista previa == alta', async () => {
    const ctx = setup();
    await seededPlan(ctx, ['endo'], 40);
    ctx.rateSource.set(40);
    const r = await ctx.preview.execute('p1', 'plan-1', {}, DENTIST_ACTOR);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].changed).toBe(false);
    expect(r.lines[0].after.price).toBe(4000);
  });

  it('vista previa: reconvierte con la tasa de hoy, reinicia la validez y no escribe nada', async () => {
    const ctx = setup();
    const plan = await seededPlan(ctx);
    ctx.rateSource.set(40);
    const r = await ctx.preview.execute('p1', 'plan-1', {}, DENTIST_ACTOR);
    expect(r.lines.map((l) => [l.before.price, l.after.price])).toEqual(
      expect.arrayContaining([
        [3600, 4000],
        [1440, 1600],
      ]),
    );
    expect(r.rate).toMatchObject({ currency: 'USD', toPerBase: 40 });
    expect(r.previousValidity).toEqual({
      issuedOn: '2026-09-01',
      validUntil: '2026-10-01',
    });
    expect(r.validity).toEqual({
      issuedOn: '2026-11-09',
      validUntil: '2026-12-09',
    });
    expect(r.totals).toEqual({ before: 5040, after: 5600 });
    expect(ctx.repo.plan('plan-1').items.map((i) => i.price)).toEqual(
      plan.items.map((i) => i.price),
    );
    // Una tasa por moneda en la petición, no una por ítem.
    expect(ctx.rateSource.calls).toBe(2 + 1);
  });

  it('aplicar con la huella de la vista previa: escribe precios y foto, y la validez nueva', async () => {
    const ctx = setup();
    await seededPlan(ctx);
    ctx.rateSource.set(40);
    const preview = await ctx.preview.execute(
      'p1',
      'plan-1',
      {},
      DENTIST_ACTOR,
    );
    const applied = await ctx.apply.execute(
      'p1',
      'plan-1',
      { previewHash: preview.previewHash },
      DENTIST_ACTOR,
      KEY,
    );
    expect(applied.replayed).toBe(false);
    expect(applied.record).toMatchObject({
      previewHash: preview.previewHash,
      actorUserId: DENTIST_ACTOR.userId,
      validity: { issuedOn: '2026-11-09', validUntil: '2026-12-09' },
      totals: { before: 5040, after: 5600 },
    });
    const stored = ctx.repo.plan('plan-1');
    expect(stored.items.map((i) => i.price).sort()).toEqual([1600, 4000]);
    expect(stored.items[0].referenceRate?.toPerBase).toBe(40);
    expect(stored.quoteIssuedOn).toBe('2026-11-09');
    expect(stored.quoteValidUntil).toBe('2026-12-09');
  });

  it('un borrador sin fechas queda con fechas (recotizar es una emisión)', async () => {
    const ctx = setup();
    const plan = await seededPlan(ctx, ['endo']);
    ctx.repo.seed({
      ...plan,
      status: TreatmentPlanStatus.DRAFT,
      quoteIssuedOn: null,
      quoteValidUntil: null,
    });
    ctx.setDays(15);
    const preview = await ctx.preview.execute(
      'p1',
      'plan-1',
      {},
      DENTIST_ACTOR,
    );
    expect(preview.previousValidity).toBeNull();
    await ctx.apply.execute(
      'p1',
      'plan-1',
      { previewHash: preview.previewHash },
      DENTIST_ACTOR,
      KEY,
    );
    expect(ctx.repo.plan('plan-1')).toMatchObject({
      quoteIssuedOn: '2026-11-09',
      quoteValidUntil: '2026-11-24',
    });
  });

  it('huella obsoleta (cambió el precio, la tasa o la validez) → 409 y nada se escribe', async () => {
    const ctx = setup();
    await seededPlan(ctx);
    ctx.rateSource.set(40);
    const preview = await ctx.preview.execute(
      'p1',
      'plan-1',
      {},
      DENTIST_ACTOR,
    );
    const before = structuredClone(ctx.repo.plan('plan-1'));
    for (const change of [
      () => ctx.rateSource.set(41),
      () => ctx.items.set('endo', catalogItem('endo', { defaultPrice: 120 })),
      () => ctx.setDays(10),
    ]) {
      const restore = { rate: 40, days: 30 };
      change();
      await expect(
        ctx.apply.execute(
          'p1',
          'plan-1',
          { previewHash: preview.previewHash },
          DENTIST_ACTOR,
          KEY,
        ),
      ).rejects.toMatchObject({
        response: { code: REPRICE_STALE_CODE },
      });
      ctx.rateSource.set(restore.rate);
      ctx.items.set('endo', catalogItem('endo'));
      ctx.setDays(restore.days);
    }
    expect(ctx.repo.plan('plan-1')).toEqual(before);
    expect(ctx.repo.records).toEqual([]);
  });

  it('un ítem que cambia entre la lectura y el bloqueo → 409 obsoleta', async () => {
    const ctx = setup();
    await seededPlan(ctx);
    ctx.rateSource.set(40);
    const preview = await ctx.preview.execute(
      'p1',
      'plan-1',
      {},
      DENTIST_ACTOR,
    );
    ctx.repo.beforeLock = (plan) => {
      plan.items[0].price = 3500;
    };
    await expect(
      ctx.apply.execute(
        'p1',
        'plan-1',
        { previewHash: preview.previewHash },
        DENTIST_ACTOR,
        KEY,
      ),
    ).rejects.toMatchObject({ response: { code: REPRICE_STALE_CODE } });
    expect(ctx.repo.records).toEqual([]);
  });

  it('Idempotency-Key: obligatoria y UUID; la misma petición devuelve lo aplicado; otra → 422', async () => {
    const ctx = setup();
    await seededPlan(ctx);
    ctx.rateSource.set(40);
    const preview = await ctx.preview.execute(
      'p1',
      'plan-1',
      {},
      DENTIST_ACTOR,
    );
    const body = { previewHash: preview.previewHash };
    await expect(
      ctx.apply.execute('p1', 'plan-1', body, DENTIST_ACTOR, undefined),
    ).rejects.toThrow(
      new BadRequestException(REPRICE_IDEMPOTENCY_KEY_REQUIRED_MESSAGE),
    );
    await expect(
      ctx.apply.execute('p1', 'plan-1', body, DENTIST_ACTOR, 'no-uuid'),
    ).rejects.toThrow(new BadRequestException(IDEMPOTENCY_KEY_INVALID_MESSAGE));

    const first = await ctx.apply.execute(
      'p1',
      'plan-1',
      body,
      DENTIST_ACTOR,
      KEY,
    );
    // Repetida después de aplicar: la vista previa ya no coincide, pero la
    // clave devuelve lo aplicado sin volver a escribir.
    const again = await ctx.apply.execute(
      'p1',
      'plan-1',
      body,
      DENTIST_ACTOR,
      KEY.toUpperCase(),
    );
    expect(again).toEqual({ record: first.record, replayed: true });
    expect(ctx.repo.records).toHaveLength(1);

    const err = await ctx.apply
      .execute(
        'p1',
        'plan-1',
        { ...body, itemIds: [ctx.repo.plan('plan-1').items[0].id] },
        DENTIST_ACTOR,
        KEY,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({
      code: REPRICE_IDEMPOTENCY_KEY_REUSED_CODE,
    });
    expect(ctx.repo.records).toHaveLength(1);
  });

  it('una repetición devuelve lo aplicado aunque después el plan se acepte o cambie la tasa', async () => {
    const ctx = setup();
    const plan = await seededPlan(ctx);
    ctx.rateSource.set(40);
    const itemIds = [plan.items[0].id];
    const p = await ctx.preview.execute(
      'p1',
      'plan-1',
      { itemIds },
      DENTIST_ACTOR,
    );
    const body = { previewHash: p.previewHash, itemIds };
    const first = await ctx.apply.execute(
      'p1',
      'plan-1',
      body,
      DENTIST_ACTOR,
      KEY,
    );
    ctx.repo.seed({
      ...ctx.repo.plan('plan-1'),
      status: TreatmentPlanStatus.ACCEPTED,
      items: ctx.repo
        .plan('plan-1')
        .items.map((i) => ({ ...i, status: TreatmentPlanItemStatus.ACCEPTED })),
    });
    ctx.rateSource.set(null);
    const again = await ctx.apply.execute(
      'p1',
      'plan-1',
      body,
      DENTIST_ACTOR,
      KEY,
    );
    expect(again).toEqual({ record: first.record, replayed: true });
  });

  it('I-2: la misma clave y el mismo cuerpo en la ruta de OTRO paciente → 422, nada se devuelve ni escribe', async () => {
    const ctx = setup();
    await seededPlan(ctx);
    ctx.rateSource.set(40);
    const p = await ctx.preview.execute('p1', 'plan-1', {}, DENTIST_ACTOR);
    const body = { previewHash: p.previewHash };
    await ctx.apply.execute('p1', 'plan-1', body, DENTIST_ACTOR, KEY);
    const err = await ctx.apply
      .execute('p2', 'plan-1', body, DENTIST_ACTOR, KEY)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(ctx.repo.records).toHaveLength(1);
  });

  it('I-1: recotizar solo algunos ítems no renueva la validez del plan', async () => {
    const ctx = setup();
    const plan = await seededPlan(ctx);
    ctx.rateSource.set(40);
    const itemIds = [plan.items[0].id];
    const p = await ctx.preview.execute(
      'p1',
      'plan-1',
      { itemIds },
      DENTIST_ACTOR,
    );
    expect(p).toMatchObject({
      validityRenewed: false,
      validity: { issuedOn: '2026-09-01', validUntil: '2026-10-01' },
    });
    const applied = await ctx.apply.execute(
      'p1',
      'plan-1',
      { previewHash: p.previewHash, itemIds },
      DENTIST_ACTOR,
      KEY,
    );
    expect(applied.record).toMatchObject({
      validityRenewed: false,
      validityNote:
        'Quedan ítems con precios anteriores: la validez no se renueva.',
    });
    expect(ctx.repo.plan('plan-1')).toMatchObject({
      quoteIssuedOn: '2026-09-01',
      quoteValidUntil: '2026-10-01',
    });
    expect(
      ctx.repo.plan('plan-1').items.find((i) => i.id === itemIds[0])?.price,
    ).not.toBe(plan.items[0].price);
  });

  it('la huella de la petición no depende del orden ni de repetir ítems', () => {
    const a = repricingRequestFingerprint('p1', 'plan-1', {
      previewHash: 'ab',
      itemIds: ['b', 'a', 'a'],
    });
    expect(
      repricingRequestFingerprint('P1', 'PLAN-1', {
        previewHash: 'AB',
        itemIds: ['a', 'b'],
      }),
    ).toBe(a);
    expect(
      repricingRequestFingerprint('p1', 'plan-1', { previewHash: 'ab' }),
    ).not.toBe(a);
  });

  it('plan aceptado, con abonos o de otro paciente: 409/404 en vista previa y al aplicar', async () => {
    const ctx = setup();
    const plan = await seededPlan(ctx, ['endo']);
    ctx.repo.facts = { ...ctx.repo.facts, hasLivePayments: true };
    await expect(
      ctx.preview.execute('p1', 'plan-1', {}, DENTIST_ACTOR),
    ).rejects.toThrow(new ConflictException(REPRICE_PAYMENTS_MESSAGE));
    await expect(
      ctx.apply.execute(
        'p1',
        'plan-1',
        { previewHash: 'a'.repeat(64) },
        DENTIST_ACTOR,
        KEY,
      ),
    ).rejects.toThrow(new ConflictException(REPRICE_PAYMENTS_MESSAGE));
    ctx.repo.facts = { ...ctx.repo.facts, hasLivePayments: false };
    ctx.repo.seed({ ...plan, status: TreatmentPlanStatus.ACCEPTED });
    await expect(
      ctx.preview.execute('p1', 'plan-1', {}, DENTIST_ACTOR),
    ).rejects.toThrow(ConflictException);
    await expect(
      ctx.preview.execute('p2', 'plan-1', {}, DENTIST_ACTOR),
    ).rejects.toThrow(NotFoundException);
    expect(ctx.repo.records).toEqual([]);
  });

  it('sin ninguna línea que aplicar (todo sin tasa) → 409 REPRICE_NOTHING_TO_APPLY', async () => {
    const ctx = setup();
    await seededPlan(ctx, ['endo']);
    ctx.rateSource.set(null);
    const preview = await ctx.preview.execute(
      'p1',
      'plan-1',
      {},
      DENTIST_ACTOR,
    );
    expect(preview.lines).toEqual([]);
    expect(preview.skipped).toEqual([
      expect.objectContaining({ reason: 'NO_RATE', currency: 'USD' }),
    ]);
    await expect(
      ctx.apply.execute(
        'p1',
        'plan-1',
        { previewHash: preview.previewHash },
        DENTIST_ACTOR,
        KEY,
      ),
    ).rejects.toMatchObject({ response: { code: REPRICE_NOTHING_CODE } });
  });

  it('ítems pedidos: el no propuesto → 409', async () => {
    const ctx = setup();
    const plan = await seededPlan(ctx);
    ctx.repo.seed({
      ...plan,
      items: plan.items.map((i, n) =>
        n === 0 ? { ...i, status: TreatmentPlanItemStatus.ACCEPTED } : i,
      ),
    });
    await expect(
      ctx.preview.execute(
        'p1',
        'plan-1',
        { itemIds: [plan.items[0].id] },
        DENTIST_ACTOR,
      ),
    ).rejects.toThrow(ConflictException);
    const ok = await ctx.preview.execute(
      'p1',
      'plan-1',
      { itemIds: [plan.items[1].id] },
      DENTIST_ACTOR,
    );
    expect(ok.lines.map((l) => l.itemId)).toEqual([plan.items[1].id]);
    expect(ok.skipped).toEqual([]);
  });

  it('sede sin zona válida → 409 LOCATION_TIMEZONE_REQUIRED', async () => {
    const ctx = setup({ zone: null });
    await seededPlan(ctx, ['endo']);
    await expect(
      ctx.preview.execute('p1', 'plan-1', {}, DENTIST_ACTOR),
    ).rejects.toMatchObject({
      response: { code: 'LOCATION_TIMEZONE_REQUIRED' },
    });
  });

  it('otra clave para la misma vista previa ya aplicada → 409 obsoleta (no recotiza dos veces)', async () => {
    const ctx = setup();
    await seededPlan(ctx);
    ctx.rateSource.set(40);
    const preview = await ctx.preview.execute(
      'p1',
      'plan-1',
      {},
      DENTIST_ACTOR,
    );
    await ctx.apply.execute(
      'p1',
      'plan-1',
      { previewHash: preview.previewHash },
      DENTIST_ACTOR,
      KEY,
    );
    await expect(
      ctx.apply.execute(
        'p1',
        'plan-1',
        { previewHash: preview.previewHash },
        DENTIST_ACTOR,
        OTHER_KEY,
      ),
    ).rejects.toMatchObject({ response: { code: REPRICE_STALE_CODE } });
    expect(ctx.repo.records).toHaveLength(1);
  });
});
