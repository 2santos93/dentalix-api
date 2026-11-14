import { referenceCurrencyDigitsCatalog } from '../../../../shared/money/__fixtures__/reference-currency-digits';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AgreementKind,
  CatalogKind,
  ClinicRole,
  DiscountReason,
  PriceSource,
  TreatmentPlanStatus,
} from '@prisma/client';
import {
  ADMIN_ACTOR,
  ASSISTANT_ACTOR,
  DENTIST_ACTOR,
  FIXED_CLOCK,
  testDiscountPolicy,
} from './__fixtures__/discount-fixtures';
import { InMemoryTreatmentPlanRepository } from './__fixtures__/in-memory-treatment-plan.repository';
import {
  PRICING_TODAY,
  catalogPricing,
} from './__fixtures__/catalog-pricing-source';
import { AddTreatmentPlanItemUseCase } from './add-treatment-plan-item.use-case';
import { UpdateTreatmentPlanItemUseCase } from './update-treatment-plan-item.use-case';
import { ApplyBulkDiscountUseCase } from './apply-bulk-discount.use-case';
import { GetPriceQuoteUseCase } from './get-price-quote.use-case';
import {
  DISCOUNT_REFERENCE_RATE_MISSING_CODE,
  referenceRateMissingMessage,
} from './reference-rate';
import {
  priceBelowCatalogCapMessage,
  priceBelowCatalogReasonMessage,
} from '../../../discounts/domain/effective-discount';
import type { FrozenReferenceRate } from '../../../discounts/domain/reference-in-plan';
import { NO_DISCOUNT_ALLOWED_MESSAGE } from '../../domain/pricing/resolve-item-price';
import type { DentalCatalogRepository } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogItem } from '../../../dental-catalog/domain/entities/dental-catalog-item.entity';
import type { PricingContext } from '../../domain/pricing/resolve-item-price';
import type { ReferenceRateSource } from '../../domain/ports/reference-rate-source.port';
import {
  lookupReferenceRate,
  referenceRateDay,
} from '../reference-rate-lookup';
import { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';
import type { GetRatesForDateUseCase } from '../../../exchange/application/use-cases/get-rates-for-date.use-case';
import {
  ExchangeRateBudgetExceededError,
  ExchangeRateProviderNotRespondingError,
  ExchangeRateUnavailableError,
} from '../../../exchange/domain/ports/exchange-rate-provider.port';

// DX-513-bis: el catálogo de la clínica está en VES (corona de 3.600,00 Bs.)
// y la tasa MANUAL de hoy es 880 Bs./USD. En un plan en USD la referencia del
// descuento es la del catálogo CONVERTIDA (3.600 / 880 = 4,09 USD), congelada
// en el ítem con la tasa; el tope por rol, el motivo y `allowDiscount` se
// miden frente a ella. Sin tasa, 422 y nada se escribe.
const CROWN = {
  id: 'crown',
  kind: CatalogKind.PROCEDURE,
  defaultPrice: 3600,
  allowDiscount: true,
  category: 'Prótesis',
} as DentalCatalogItem;
const LOCKED = { ...CROWN, id: 'locked', allowDiscount: false };

const catalog = {
  findById: (id: string) =>
    Promise.resolve([CROWN, LOCKED].find((c) => c.id === id) ?? null),
  findByIds: (ids: string[]) =>
    Promise.resolve(
      ids.map((id) => [CROWN, LOCKED].find((c) => c.id === id) ?? CROWN),
    ),
} as unknown as DentalCatalogRepository;

const RATE_DAY = '2026-10-16';
const RATE_880: FrozenReferenceRate = {
  fromPerBase: 880,
  toPerBase: 1,
  source: 'MANUAL',
  rateDate: RATE_DAY,
};

/**
 * Fuente de tasas de las specs: unidades por 1 USD de cada moneda con tasa
 * (USD vale 1). Una moneda sin tasa: «sin tasa». `calls` es el espía.
 */
function rates(
  perBase: Record<string, number> = { VES: 880 },
): ReferenceRateSource & { calls: [string, string][] } {
  const calls: [string, string][] = [];
  const of = (c: string) => (c === 'USD' ? 1 : perBase[c]);
  return {
    calls,
    rateFor(from, to) {
      calls.push([from, to]);
      const missing = [from, to].find((c) => of(c) === undefined);
      if (missing) {
        return Promise.resolve({
          kind: 'missing',
          currency: missing,
          date: PRICING_TODAY,
          // El día con el formato de la sede (es-VE), nunca ISO.
          dateLabel: '17/10/2026',
        });
      }
      return Promise.resolve({
        kind: 'rate',
        rate: {
          fromPerBase: of(from),
          toPerBase: of(to),
          source: 'MANUAL',
          rateDate: RATE_DAY,
        },
        toDigits: 2,
      });
    },
  };
}

/** La fuente real (`lookupReferenceRate`) sobre una lectura de tasas dada. */
function convertingRates(
  read: GetRatesForDateUseCase['execute'],
): ReferenceRateSource {
  const convert = new ConvertAmountUseCase({
    execute: read,
  } as unknown as GetRatesForDateUseCase);
  return {
    rateFor: (from, to) =>
      lookupReferenceRate(convert, { from, to, date: PRICING_TODAY }, 2),
  };
}

function setup(
  planCurrency: 'USD' | 'VES' | 'EUR',
  options: {
    pricing?: Partial<PricingContext>;
    rateSource?: ReferenceRateSource;
  } = {},
) {
  const repo = new InMemoryTreatmentPlanRepository();
  repo.seedPlan({
    id: 'plan1',
    status: TreatmentPlanStatus.DRAFT,
    currency: planCurrency,
  });
  const policy = testDiscountPolicy();
  const rateSource = options.rateSource ?? rates();
  const pricing = catalogPricing(catalog, {
    catalogCurrency: 'VES',
    ...options.pricing,
  });
  return {
    repo,
    rateSource,
    add: new AddTreatmentPlanItemUseCase(
      repo,
      pricing,
      policy,
      FIXED_CLOCK,
      rateSource,
    ),
    update: new UpdateTreatmentPlanItemUseCase(
      repo,
      catalog,
      policy,
      FIXED_CLOCK,
      rateSource,
    ),
    bulk: new ApplyBulkDiscountUseCase(
      repo,
      policy,
      FIXED_CLOCK,
      catalog,
      referenceCurrencyDigitsCatalog(),
      rateSource,
    ),
    quote: new GetPriceQuoteUseCase(
      pricing,
      { patientExists: () => Promise.resolve(true) },
      rateSource,
    ),
  };
}

const CROWN_ITEM = { toothNumber: '11', catalogItemId: 'crown' };

describe('referencia convertida a la moneda del plan (DX-513-bis)', () => {
  describe('alta en un plan USD con el catálogo en VES a 880 (test 3)', () => {
    it('la referencia es 4,09 USD y queda congelada con la tasa; a 4,09 no hay descuento ni firma', async () => {
      const { add } = setup('USD');
      const item = await add.execute(
        'plan1',
        { ...CROWN_ITEM, price: 4.09 },
        ASSISTANT_ACTOR,
      );
      expect(item).toMatchObject({
        price: 4.09,
        catalogPrice: 3600,
        basePrice: 3600,
        catalogCurrency: 'VES',
        referenceCurrency: 'VES',
        referencePriceInPlan: 4.09,
        basePriceInPlan: 4.09,
        referenceRate: RATE_880,
        discount: 0,
        discountReason: null,
        discountById: null,
      });
    });

    it('4,00 USD por la asistente (tope 0 %): 403 de precio por debajo del de catálogo', async () => {
      const { add, repo } = setup('USD');
      await expect(
        add.execute('plan1', { ...CROWN_ITEM, price: 4 }, ASSISTANT_ACTOR),
      ).rejects.toThrow(new ForbiddenException(priceBelowCatalogCapMessage(0)));
      expect((await repo.findPlanById('plan1'))!.items).toHaveLength(0);
    });

    it('el DENTIST a 3,60 USD (12 %): 403 con su tope del 10 %', async () => {
      const { add } = setup('USD');
      await expect(
        add.execute('plan1', { ...CROWN_ITEM, price: 3.6 }, DENTIST_ACTOR),
      ).rejects.toThrow(
        new ForbiddenException(priceBelowCatalogCapMessage(10)),
      );
    });

    it('el ADMIN a 3,60: sin motivo 422; con motivo, se firma', async () => {
      const { add } = setup('USD');
      await expect(
        add.execute('plan1', { ...CROWN_ITEM, price: 3.6 }, ADMIN_ACTOR),
      ).rejects.toThrow(
        new UnprocessableEntityException(priceBelowCatalogReasonMessage(10)),
      );
      const item = await add.execute(
        'plan1',
        {
          ...CROWN_ITEM,
          price: 3.6,
          discountReason: DiscountReason.LOYALTY,
        },
        ADMIN_ACTOR,
      );
      expect(item).toMatchObject({
        price: 3.6,
        referencePriceInPlan: 4.09,
        discountReason: DiscountReason.LOYALTY,
        discountById: ADMIN_ACTOR.userId,
      });
    });

    it('al revés: catálogo USD (fijado) y plan VES; 4,50 USD son 3.960 Bs. y 3.900 es una rebaja (403 de la asistente)', async () => {
      const usdCrown = { ...CROWN, defaultPrice: 4.5 };
      const usdCatalog = {
        findById: () => Promise.resolve(usdCrown),
      } as unknown as DentalCatalogRepository;
      const repo = new InMemoryTreatmentPlanRepository();
      repo.seedPlan({ id: 'plan1', currency: 'VES' });
      const add = new AddTreatmentPlanItemUseCase(
        repo,
        catalogPricing(usdCatalog, { catalogCurrency: 'USD' }),
        testDiscountPolicy(),
        FIXED_CLOCK,
        rates(),
      );
      await expect(
        add.execute('plan1', { ...CROWN_ITEM, price: 3900 }, ASSISTANT_ACTOR),
      ).rejects.toThrow(new ForbiddenException(priceBelowCatalogCapMessage(0)));
      await expect(
        add.execute('plan1', CROWN_ITEM, ASSISTANT_ACTOR),
      ).resolves.toMatchObject({
        price: 3960,
        referencePriceInPlan: 3960,
        referenceRate: { fromPerBase: 1, toPerBase: 880 },
      });
    });
  });

  it('alta sin precio: se guarda la referencia convertida (4,09), no los 3.600 crudos (test 4, C1)', async () => {
    const { add } = setup('USD');
    await expect(
      add.execute('plan1', CROWN_ITEM, ASSISTANT_ACTOR),
    ).resolves.toMatchObject({ price: 4.09, discountById: null });
  });

  it('prestación sin descuentos entre monedas: 4,00 USD es una rebaja y responde 400 (test 5, C3)', async () => {
    const { add } = setup('USD');
    await expect(
      add.execute(
        'plan1',
        { toothNumber: '11', catalogItemId: 'locked', price: 4 },
        ADMIN_ACTOR,
      ),
    ).rejects.toThrow(new BadRequestException(NO_DISCOUNT_ALLOWED_MESSAGE));
  });

  describe('sin tasa (test 6)', () => {
    const missing422 = (
      currency: string,
      dateLabel: string | null,
      role: ClinicRole = ClinicRole.ADMIN,
    ) =>
      new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        code: DISCOUNT_REFERENCE_RATE_MISSING_CODE,
        message: referenceRateMissingMessage(
          { currency, dateLabel },
          'VES',
          'USD',
          role,
        ),
        currency,
      });

    it('tasa MANUAL sin registrar: 422 DISCOUNT_REFERENCE_RATE_MISSING, en español, y no se escribe nada', async () => {
      const { add, repo } = setup('USD', { rateSource: rates({}) });
      const error = await add
        .execute('plan1', { ...CROWN_ITEM, price: 4.09 }, ADMIN_ACTOR)
        .catch((e: unknown) => e);
      expect(error).toEqual(missing422('VES', '17/10/2026'));
      expect((error as UnprocessableEntityException).getResponse()).toEqual(
        expect.objectContaining({
          code: DISCOUNT_REFERENCE_RATE_MISSING_CODE,
          message:
            'No hay tasa de VES para el 17/10/2026: el precio de catálogo está en VES y el plan en USD, y sin la tasa no se puede saber si el precio es un descuento. Regístrala en Ajustes › Tasa de cambio o usa una lista de precios en USD.',
        }),
      );
      expect((await repo.findPlanById('plan1'))!.items).toHaveLength(0);
    });

    it('L7: quien no gestiona las tasas recibe «pide a un administrador…», con el día de la sede', async () => {
      const { add } = setup('USD', { rateSource: rates({}) });
      const error = (await add
        .execute('plan1', { ...CROWN_ITEM, price: 4.09 }, DENTIST_ACTOR)
        .catch((e: unknown) => e)) as UnprocessableEntityException;
      expect(error.getResponse()).toMatchObject({
        message:
          'No hay tasa de VES para el 17/10/2026: el precio de catálogo está en VES y el plan en USD, y sin la tasa no se puede saber si el precio es un descuento. Pide a un administrador que registre la tasa del día o una lista de precios en USD.',
      });
      expect(JSON.stringify(error.getResponse())).not.toContain(PRICING_TODAY);
    });

    it('L6: un plan firmado responde su 409 antes que «sin tasa»', async () => {
      const { add, repo } = setup('USD', { rateSource: rates({}) });
      repo.seedPlan({
        id: 'signed',
        currency: 'USD',
        status: TreatmentPlanStatus.ACCEPTED,
        acceptance: {
          signerName: 'Ana Pérez',
          acceptedAt: new Date('2026-10-16T15:00:00.000Z'),
          remote: null,
        },
      });
      await expect(
        add.execute('signed', { ...CROWN_ITEM, price: 4.09 }, ADMIN_ACTOR),
      ).rejects.toBeInstanceOf(ConflictException);
      // Un plan cerrado, igual.
      repo.seedPlan({
        id: 'closed',
        currency: 'USD',
        status: TreatmentPlanStatus.COMPLETED,
      });
      await expect(
        add.execute('closed', { ...CROWN_ITEM, price: 4.09 }, ADMIN_ACTOR),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it.each([
      [
        'el proveedor no contesta',
        new ExchangeRateProviderNotRespondingError('timeout'),
      ],
      [
        'presupuesto agotado',
        new ExchangeRateBudgetExceededError('CLINIC', 60),
      ],
      ['sin clave del proveedor', new ExchangeRateUnavailableError('sin id')],
    ])('%s: 422, nunca 500', async (_label, failure) => {
      const { add, repo } = setup('USD', {
        rateSource: convertingRates(() => Promise.reject(failure)),
      });
      await expect(
        add.execute('plan1', { ...CROWN_ITEM, price: 4.09 }, ADMIN_ACTOR),
      ).rejects.toThrow(missing422('VES', null));
      expect((await repo.findPlanById('plan1'))!.items).toHaveLength(0);
    });

    it('un fallo que no es «sin tasa» se propaga (no se disfraza de 422)', async () => {
      const { add } = setup('USD', {
        rateSource: convertingRates(() =>
          Promise.reject(new Error('BD caída')),
        ),
      });
      await expect(
        add.execute('plan1', { ...CROWN_ITEM, price: 4.09 }, ADMIN_ACTOR),
      ).rejects.toThrow('BD caída');
    });

    it('la vista previa no lanza: rateMissing y sin precio propuesto', async () => {
      const { quote } = setup('USD', { rateSource: rates({}) });
      await expect(quote.execute('p1', 'crown', 'USD')).resolves.toMatchObject({
        price: 3600,
        referenceCurrency: 'VES',
        referencePriceInPlan: null,
        rate: null,
        rateMissing: true,
        missingRateCurrency: 'VES',
      });
    });
  });

  it('plazo MANUAL de 3 días: un domingo vale la tasa del viernes y se congela su día (test 7)', async () => {
    const sunday = '2026-10-18';
    const friday = '2026-10-16';
    const read = jest.fn((date: string) =>
      Promise.resolve({
        base: 'USD' as const,
        source: 'MANUAL' as const,
        rates: { VES: 880 },
        rateDate: date === sunday ? friday : date,
      }),
    );
    const convert = new ConvertAmountUseCase({
      execute: read,
    } as unknown as GetRatesForDateUseCase);
    const { add } = setup('USD', {
      rateSource: {
        rateFor: (from, to) =>
          lookupReferenceRate(convert, { from, to, date: sunday }, 2),
      },
    });
    const item = await add.execute('plan1', CROWN_ITEM, ASSISTANT_ACTOR);
    expect(read).toHaveBeenCalledWith(sunday, {
      currencies: ['VES', 'USD'],
    });
    expect(item.referenceRate).toEqual({ ...RATE_880, rateDate: friday });
  });

  it('L7: la fuente da el día de «sin tasa» con el formato de la sede, nunca ISO', async () => {
    const convert = new ConvertAmountUseCase({
      execute: (date: string) =>
        Promise.resolve({
          base: 'USD' as const,
          source: 'MANUAL' as const,
          rates: {},
          rateDate: date,
        }),
    } as unknown as GetRatesForDateUseCase);
    await expect(
      lookupReferenceRate(
        convert,
        { from: 'VES', to: 'USD', date: '2026-11-07' },
        2,
        (day) => day.split('-').reverse().join('/'),
      ),
    ).resolves.toEqual({
      kind: 'missing',
      currency: 'VES',
      date: '2026-11-07',
      dateLabel: '07/11/2026',
    });
  });

  it('el día de la tasa: la sede con MANUAL; con el proveedor, nunca posterior al día UTC (§4.11)', () => {
    expect(referenceRateDay('MANUAL', '2026-11-08', '2026-11-07')).toBe(
      '2026-11-08',
    );
    expect(referenceRateDay('AUTOMATIC', '2026-11-08', '2026-11-07')).toBe(
      '2026-11-07',
    );
    // Venezuela (UTC−4) por la noche: el día UTC ya es el siguiente.
    expect(referenceRateDay('AUTOMATIC', '2026-11-07', '2026-11-08')).toBe(
      '2026-11-07',
    );
  });

  it('plan EUR con el catálogo VES y solo la tasa de VES registrada: 422 que nombra EUR (test 8)', async () => {
    const { add, repo } = setup('EUR', {
      rateSource: convertingRates((date) =>
        Promise.resolve({
          base: 'USD' as const,
          source: 'MANUAL' as const,
          rates: { VES: 880 },
          rateDate: date,
        }),
      ),
    });
    const error = await add
      .execute('plan1', { ...CROWN_ITEM, price: 3.76 }, ADMIN_ACTOR)
      .catch((e: unknown) => e as UnprocessableEntityException);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect(error).toMatchObject({
      response: {
        code: DISCOUNT_REFERENCE_RATE_MISSING_CODE,
        currency: 'EUR',
        message: expect.stringMatching(
          /^No hay tasa de EUR para hoy: /,
        ) as unknown,
      },
    });
    expect((await repo.findPlanById('plan1'))!.items).toHaveLength(0);
  });

  it('PRICE_LIST de la sede en la moneda del plan: sin pedir tasa y con la referencia en USD (test 9)', async () => {
    const { add, rateSource, quote } = setup('USD', {
      pricing: { locationList: { price: 4.5, currency: 'USD' } },
    });
    const item = await add.execute('plan1', CROWN_ITEM, ASSISTANT_ACTOR);
    expect(item).toMatchObject({
      price: 4.5,
      priceSource: PriceSource.PRICE_LIST,
      referenceCurrency: 'USD',
      referencePriceInPlan: 4.5,
      basePriceInPlan: null,
      referenceRate: null,
    });
    await quote.execute('p1', 'crown', 'USD');
    expect((rateSource as ReturnType<typeof rates>).calls).toEqual([]);
  });

  it('catálogo en la moneda del plan: tampoco se pide tasa', async () => {
    const { add, rateSource } = setup('VES');
    await expect(
      add.execute('plan1', CROWN_ITEM, ASSISTANT_ACTOR),
    ).resolves.toMatchObject({
      price: 3600,
      referenceCurrency: 'VES',
      referencePriceInPlan: 3600,
      referenceRate: null,
    });
    expect((rateSource as ReturnType<typeof rates>).calls).toEqual([]);
  });

  it('AGREEMENT_PERCENT entre monedas: base y referencia congeladas en USD (test 10)', async () => {
    const { add } = setup('USD', {
      pricing: {
        agreement: {
          id: 'ag1',
          name: 'Convenio 10',
          kind: AgreementKind.PERCENT_DISCOUNT,
          percent: 10,
          percentByCategory: null,
          priceListId: null,
          locationId: null,
          active: true,
          validFrom: null,
          validTo: null,
          assignmentValidFrom: null,
          assignmentValidTo: null,
        },
      },
    });
    const item = await add.execute('plan1', CROWN_ITEM, ASSISTANT_ACTOR);
    // 3.600 − 10 % = 3.240 Bs. → 3,68 USD; la base, 4,09 USD: la rebaja de
    // convenio es 0,41 USD, en la moneda del plan.
    expect(item).toMatchObject({
      priceSource: PriceSource.AGREEMENT_PERCENT,
      catalogPrice: 3240,
      basePrice: 3600,
      referencePriceInPlan: 3.68,
      basePriceInPlan: 4.09,
      price: 3.68,
      referenceRate: RATE_880,
    });
  });

  describe('edición y «Descuento %» de un ítem con foto (tests 11 y 12)', () => {
    function withSnapshot(rateSource = rates({ VES: 1000 })) {
      const ctx = setup('USD', { rateSource });
      ctx.repo.seedItem({
        id: 'item1',
        planId: 'plan1',
        catalogItemId: 'crown',
        catalogPrice: 3600,
        basePrice: 3600,
        catalogCurrency: 'VES',
        priceSource: PriceSource.CATALOG,
        referenceCurrency: 'VES',
        referencePriceInPlan: 4.09,
        basePriceInPlan: 4.09,
        referenceRate: RATE_880,
        price: 4.09,
      });
      return ctx;
    }

    it('editar no vuelve a pedir la tasa (aunque hoy sea otra) y mide con la foto', async () => {
      const { update, rateSource, repo } = withSnapshot();
      // Con la tasa de hoy (1.000) la referencia sería 3,60: 4,00 no sería
      // descuento. Con la foto (4,09) sí: 403 a la asistente.
      await expect(
        update.execute('item1', { price: 4 }, ASSISTANT_ACTOR),
      ).rejects.toThrow(new ForbiddenException(priceBelowCatalogCapMessage(0)));
      expect((rateSource as ReturnType<typeof rates>).calls).toEqual([]);
      expect((await repo.findItemById('item1'))!).toMatchObject({
        price: 4.09,
        referencePriceInPlan: 4.09,
        referenceRate: RATE_880,
      });
    });

    it('subir el precio sigue libre y la foto no cambia', async () => {
      const { update } = withSnapshot();
      await expect(
        update.execute('item1', { price: 5 }, ASSISTANT_ACTOR),
      ).resolves.toMatchObject({ price: 5, referencePriceInPlan: 4.09 });
    });

    it('«Descuento %» sobre un ítem rebajado: el tope cuenta la rebaja frente a la referencia convertida + el %', async () => {
      const { bulk, update, rateSource } = withSnapshot();
      await update.execute(
        'item1',
        { price: 4, discountReason: DiscountReason.LOYALTY },
        ADMIN_ACTOR,
      );
      // 0,09 de rebaja + 9 % de 4,00 (0,36) = 0,45 sobre 4,09 = 11 % > 10 %.
      await expect(
        bulk.execute(
          'plan1',
          { itemIds: ['item1'], percent: 9 },
          DENTIST_ACTOR,
        ),
      ).rejects.toThrow(
        new ForbiddenException(priceBelowCatalogCapMessage(10)),
      );
      // 0,09 + 5 % (0,20) = 0,29 sobre 4,09 = 7,1 %: el DENTIST, sin motivo.
      const {
        items: [item],
      } = await bulk.execute(
        'plan1',
        { itemIds: ['item1'], percent: 5 },
        DENTIST_ACTOR,
      );
      expect(item).toMatchObject({ discount: 0.2, referencePriceInPlan: 4.09 });
      expect((rateSource as ReturnType<typeof rates>).calls).toEqual([]);
    });
  });

  describe('ítem anterior sin foto (test 13, §5.8)', () => {
    function legacy(rateSource: ReferenceRateSource = rates()) {
      const ctx = setup('USD', { rateSource });
      ctx.repo.seedItem({
        id: 'item1',
        planId: 'plan1',
        catalogItemId: 'crown',
        catalogPrice: 3600,
        basePrice: 3600,
        catalogCurrency: 'VES',
        priceSource: PriceSource.CATALOG,
        price: 4.09,
      });
      return ctx;
    }

    it('la primera bajada de precio toma la foto con la tasa de hoy y mide con ella (403 de la asistente)', async () => {
      const { update, repo } = legacy();
      await expect(
        update.execute('item1', { price: 4 }, ASSISTANT_ACTOR),
      ).rejects.toThrow(new ForbiddenException(priceBelowCatalogCapMessage(0)));
      // Rechazada: nada se escribe, tampoco la foto.
      expect((await repo.findItemById('item1'))!).toMatchObject({
        price: 4.09,
        referencePriceInPlan: null,
      });
      const item = await update.execute('item1', { price: 4 }, ADMIN_ACTOR);
      expect(item).toMatchObject({
        price: 4,
        referenceCurrency: 'VES',
        referencePriceInPlan: 4.09,
        basePriceInPlan: 4.09,
        referenceRate: RATE_880,
        discountById: ADMIN_ACTOR.userId,
      });
    });

    it('subir el precio no toma la foto ni pide tasa', async () => {
      const { update, rateSource } = legacy();
      await expect(
        update.execute('item1', { price: 5 }, ASSISTANT_ACTOR),
      ).resolves.toMatchObject({ price: 5, referencePriceInPlan: null });
      expect((rateSource as ReturnType<typeof rates>).calls).toEqual([]);
    });

    it('sin tasa ese día: 422 y nada cambia', async () => {
      const { update, repo } = legacy(rates({}));
      await expect(
        update.execute('item1', { price: 4 }, ADMIN_ACTOR),
      ).rejects.toMatchObject({
        response: { code: DISCOUNT_REFERENCE_RATE_MISSING_CODE },
      });
      expect((await repo.findItemById('item1'))!.price).toBe(4.09);
    });

    it('«Descuento %» también toma la foto y mide con ella', async () => {
      const { bulk } = legacy();
      await expect(
        bulk.execute(
          'plan1',
          { itemIds: ['item1'], percent: 5 },
          ASSISTANT_ACTOR,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const {
        items: [item],
      } = await bulk.execute(
        'plan1',
        { itemIds: ['item1'], percent: 5 },
        ADMIN_ACTOR,
      );
      expect(item).toMatchObject({
        discount: 0.2,
        referencePriceInPlan: 4.09,
        referenceRate: RATE_880,
      });
    });

    it('un ítem anterior en la misma moneda no toma foto: se mide como hoy', async () => {
      const ctx = setup('VES');
      ctx.repo.seedItem({
        id: 'item1',
        planId: 'plan1',
        catalogItemId: 'crown',
        catalogPrice: 3600,
        catalogCurrency: 'VES',
        priceSource: PriceSource.CATALOG,
        price: 3600,
      });
      await expect(
        ctx.update.execute('item1', { price: 3000 }, ASSISTANT_ACTOR),
      ).rejects.toThrow(new ForbiddenException(priceBelowCatalogCapMessage(0)));
      const item = await ctx.update.execute(
        'item1',
        { price: 3500 },
        ADMIN_ACTOR,
      );
      expect(item).toMatchObject({ price: 3500, referencePriceInPlan: null });
    });
  });

  it('catálogo con moneda desconocida (NULL): cifras crudas como hoy, sin tasa (§4.9)', async () => {
    const { add, rateSource } = setup('USD', {
      pricing: { catalogCurrency: null },
    });
    await expect(
      add.execute('plan1', { ...CROWN_ITEM, price: 80 }, ASSISTANT_ACTOR),
    ).rejects.toThrow(new ForbiddenException(priceBelowCatalogCapMessage(0)));
    expect((rateSource as ReturnType<typeof rates>).calls).toEqual([]);
  });

  it('la vista previa da la referencia convertida y la tasa, sin escribir nada', async () => {
    const { quote, repo } = setup('USD');
    await expect(quote.execute('p1', 'crown', 'USD')).resolves.toMatchObject({
      price: 3600,
      currency: 'USD',
      referenceCurrency: 'VES',
      referencePriceInPlan: 4.09,
      rate: RATE_880,
      rateMissing: false,
      missingRateCurrency: null,
    });
    expect((await repo.findPlanById('plan1'))!.items).toHaveLength(0);
  });
});

// DX-513-ter: lista de CONVENIO en USD (corona a 3,50) con el catálogo en VES
// (3.600 Bs.). Al dar de alta el ítem se pide la tasa del día SIN exigirla:
// con ella se congela la base convertida (4,09 USD) y su tasa, solo para el
// informe; sin ella (o con cualquier error) el ítem se crea igual, sin base.
// La referencia del tope sigue siendo el precio de lista.
describe('base convertida en las listas de convenio entre monedas (DX-513-ter)', () => {
  const LIST_AGREEMENT: Partial<PricingContext> = {
    agreement: {
      id: 'ag-list',
      name: 'Empresa',
      kind: AgreementKind.PRICE_LIST,
      percent: null,
      percentByCategory: null,
      priceListId: 'list-1',
      locationId: null,
      active: true,
      validFrom: null,
      validTo: null,
      assignmentValidFrom: null,
      assignmentValidTo: null,
    },
    agreementListPrice: { price: 3.5, currency: 'USD', active: true },
  };
  const listSetup = (rateSource?: ReferenceRateSource) =>
    setup('USD', { pricing: LIST_AGREEMENT, rateSource });

  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  describe('alta (test 3)', () => {
    it('con tasa: 201 con la base 4,09 USD y la tasa congeladas en `baseRate`; la referencia es la lista', async () => {
      const { add, rateSource } = listSetup();
      const item = await add.execute('plan1', CROWN_ITEM, ASSISTANT_ACTOR);
      expect(item).toMatchObject({
        priceSource: PriceSource.AGREEMENT_PRICE_LIST,
        agreementId: 'ag-list',
        price: 3.5,
        catalogPrice: 3.5,
        basePrice: 3600,
        catalogCurrency: 'VES',
        referenceCurrency: 'USD',
        referencePriceInPlan: 3.5,
        basePriceInPlan: 4.09,
        referenceRate: null,
        baseRate: RATE_880,
        discount: 0,
        discountById: null,
      });
      expect((rateSource as ReturnType<typeof rates>).calls).toEqual([
        ['VES', 'USD'],
      ]);
    });

    it('sin tasa: 201 igual, sin base ni tasa (nunca 422)', async () => {
      const { add, repo } = listSetup(rates({}));
      await expect(
        add.execute('plan1', CROWN_ITEM, ASSISTANT_ACTOR),
      ).resolves.toMatchObject({
        price: 3.5,
        referencePriceInPlan: 3.5,
        basePriceInPlan: null,
        referenceRate: null,
        baseRate: null,
      });
      expect((await repo.findPlanById('plan1'))!.items).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('el proveedor no contesta: 201 sin base', async () => {
      const { add } = listSetup(
        convertingRates(() =>
          Promise.reject(new ExchangeRateProviderNotRespondingError('timeout')),
        ),
      );
      await expect(
        add.execute('plan1', CROWN_ITEM, ASSISTANT_ACTOR),
      ).resolves.toMatchObject({ basePriceInPlan: null, baseRate: null });
    });

    it('cualquier otro error: 201 sin base y un aviso con el NOMBRE del error, nunca su mensaje', async () => {
      const { add } = listSetup({
        rateFor: () => Promise.reject(new TypeError('secreto 10.0.0.7')),
      });
      await expect(
        add.execute('plan1', CROWN_ITEM, ASSISTANT_ACTOR),
      ).resolves.toMatchObject({ basePriceInPlan: null, baseRate: null });
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(warn.mock.calls[0]);
      expect(logged).toContain('TypeError');
      expect(logged).not.toContain('secreto');
    });
  });

  describe('el tope no cambia: se mide contra la lista (test 4)', () => {
    it.each([
      ['con tasa', undefined],
      ['sin tasa', rates({})],
    ])(
      '%s: la asistente a 3,40 frente a 3,50 → 403',
      async (_label, source) => {
        const { add } = listSetup(source);
        await expect(
          add.execute('plan1', { ...CROWN_ITEM, price: 3.4 }, ASSISTANT_ACTOR),
        ).rejects.toThrow(
          new ForbiddenException(priceBelowCatalogCapMessage(0)),
        );
      },
    );

    it('a 3,50 no hay descuento aunque la base convertida sea 4,09', async () => {
      const { add } = listSetup();
      await expect(
        add.execute('plan1', { ...CROWN_ITEM, price: 3.5 }, ASSISTANT_ACTOR),
      ).resolves.toMatchObject({
        price: 3.5,
        discount: 0,
        discountById: null,
        discountReason: null,
        basePriceInPlan: 4.09,
      });
    });
  });

  it('la vista previa de una lista de convenio no pide tasa (test 5)', async () => {
    const { quote, rateSource } = listSetup();
    await expect(quote.execute('p1', 'crown', 'USD')).resolves.toMatchObject({
      price: 3.5,
      rate: null,
    });
    expect((rateSource as ReturnType<typeof rates>).calls).toEqual([]);
  });

  describe('edición y «Descuento %» de un ítem de lista con base (test 6)', () => {
    function withBase() {
      const ctx = listSetup(rates({ VES: 1000 }));
      ctx.repo.seedItem({
        id: 'item1',
        planId: 'plan1',
        catalogItemId: 'crown',
        catalogPrice: 3.5,
        basePrice: 3600,
        catalogCurrency: 'VES',
        priceSource: PriceSource.AGREEMENT_PRICE_LIST,
        agreementId: 'ag-list',
        agreementName: 'Empresa',
        referenceCurrency: 'USD',
        referencePriceInPlan: 3.5,
        basePriceInPlan: 4.09,
        referenceRate: RATE_880,
        price: 3.5,
      });
      return ctx;
    }

    it('editar el precio no pide tasa ni toca la base', async () => {
      const { update, rateSource } = withBase();
      await expect(
        update.execute('item1', { price: 5 }, ASSISTANT_ACTOR),
      ).resolves.toMatchObject({
        price: 5,
        referencePriceInPlan: 3.5,
        basePriceInPlan: 4.09,
        baseRate: RATE_880,
        referenceRate: null,
      });
      expect((rateSource as ReturnType<typeof rates>).calls).toEqual([]);
    });

    it('«Descuento %» tampoco', async () => {
      const { bulk, rateSource } = withBase();
      const {
        items: [item],
      } = await bulk.execute(
        'plan1',
        { itemIds: ['item1'], percent: 5 },
        DENTIST_ACTOR,
      );
      expect(item).toMatchObject({
        discount: 0.18,
        basePriceInPlan: 4.09,
        baseRate: RATE_880,
      });
      expect((rateSource as ReturnType<typeof rates>).calls).toEqual([]);
    });
  });
});
