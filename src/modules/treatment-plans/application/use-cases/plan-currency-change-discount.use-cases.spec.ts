import {
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ClinicRole,
  DiscountReason,
  PriceSource,
  TreatmentPlanStatus,
} from '@prisma/client';
import { UpdateTreatmentPlanUseCase } from './update-treatment-plan.use-case';
import { InMemoryTreatmentPlanRepository } from './__fixtures__/in-memory-treatment-plan.repository';
import { testDiscountPolicy } from './__fixtures__/discount-fixtures';
import {
  CURRENCY_CHANGE_HIDES_DISCOUNT_MESSAGE,
  CURRENCY_CHANGE_UNSIGNED_DISCOUNT_MESSAGE,
} from './item-discount';
import {
  priceBelowCatalogCapMessage,
  priceBelowCatalogReasonMessage,
} from '../../../discounts/domain/effective-discount';
import type { CurrencyWhitelist } from '../../domain/ports/currency-whitelist.port';

// DX-513 (revisión H1): la moneda del plan decide si la rebaja frente al
// catálogo cuenta como descuento. Cambiarla en un borrador con ítems vuelve a
// validar cada ítem con la moneda nueva, en la misma transacción: una rebaja
// que aparece pasa por el tope del rol, el motivo y la firma; una rebaja
// firmada que desaparecería del informe bloquea el cambio. Nunca a medias.
// Clínica en VES: catálogo de 3.600,00 VES.
const NOW = new Date('2026-10-16T15:00:00.000Z');
const ASSISTANT = { role: ClinicRole.ASSISTANT, userId: 'u-asis' };
const DENTIST = { role: ClinicRole.DENTIST, userId: 'u-dent' };
const ADMIN = { role: ClinicRole.ADMIN, userId: 'u-admin' };

const whitelist: CurrencyWhitelist = {
  has: (code: string) => Promise.resolve(['USD', 'VES'].includes(code)),
};

function setup(currency: 'USD' | 'VES') {
  const repo = new InMemoryTreatmentPlanRepository();
  repo.seedPlan({ id: 'plan1', status: TreatmentPlanStatus.DRAFT, currency });
  const uc = new UpdateTreatmentPlanUseCase(
    repo,
    whitelist,
    () => NOW,
    testDiscountPolicy(),
  );
  const crown = (over: Parameters<typeof repo.seedItem>[0] = {}) =>
    repo.seedItem({
      planId: 'plan1',
      catalogPrice: 3600,
      basePrice: 3600,
      catalogCurrency: 'VES',
      priceSource: PriceSource.CATALOG,
      price: 3600,
      ...over,
    });
  return { repo, uc, crown };
}

describe('cambiar la moneda de un plan con ítems vuelve a validar sus descuentos (DX-513)', () => {
  describe('USD → VES: la rebaja frente al catálogo en VES aparece', () => {
    it('la explotación: la asistente (0 %) con un ítem a 1 no puede pasar el plan a VES (403) y nada cambia', async () => {
      const { uc, repo, crown } = setup('USD');
      crown({ id: 'item1', price: 1 });
      await expect(
        uc.execute('plan1', { currency: 'VES' }, ASSISTANT),
      ).rejects.toThrow(new ForbiddenException(priceBelowCatalogCapMessage(0)));
      expect((await repo.findPlanById('plan1'))!.currency).toBe('USD');
    });

    it('el DENTIST (10 %) con una rebaja del 50 %: 403', async () => {
      const { uc, crown } = setup('USD');
      crown({ price: 1800 });
      await expect(
        uc.execute('plan1', { currency: 'VES' }, DENTIST),
      ).rejects.toThrow(
        new ForbiddenException(priceBelowCatalogCapMessage(10)),
      );
    });

    it('el ADMIN: sin motivo por encima del umbral, 422', async () => {
      const { uc, crown } = setup('USD');
      crown({ price: 1800 });
      await expect(
        uc.execute('plan1', { currency: 'VES' }, ADMIN),
      ).rejects.toThrow(
        new UnprocessableEntityException(priceBelowCatalogReasonMessage(10)),
      );
    });

    it('dentro del tope y con motivo, la rebaja seguiría sin firmar: 409 con el mensaje en español', async () => {
      const { uc, repo, crown } = setup('USD');
      crown({ price: 3500, discountReason: DiscountReason.LOYALTY });
      await expect(
        uc.execute('plan1', { currency: 'VES' }, ADMIN),
      ).rejects.toThrow(
        new ConflictException(CURRENCY_CHANGE_UNSIGNED_DISCOUNT_MESSAGE),
      );
      expect((await repo.findPlanById('plan1'))!.currency).toBe('USD');
    });

    it('nunca a medias: un ítem bien y otro rebajado, el plan no cambia', async () => {
      const { uc, repo, crown } = setup('USD');
      crown({ id: 'ok', price: 3600 });
      crown({ id: 'bad', price: 1 });
      await expect(
        uc.execute('plan1', { currency: 'VES' }, ADMIN),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect((await repo.findPlanById('plan1'))!.currency).toBe('USD');
    });

    it('sin rebajas (precio igual o mayor que el catálogo), cambia como siempre', async () => {
      const { uc, crown } = setup('USD');
      crown({ price: 3600 });
      crown({ price: 4000 });
      await expect(
        uc.execute('plan1', { currency: 'VES' }, ASSISTANT),
      ).resolves.toMatchObject({ currency: 'VES' });
    });

    it('una lista de precios (en la moneda del plan) no cambia de clasificación', async () => {
      const { uc, crown } = setup('USD');
      crown({
        priceSource: PriceSource.PRICE_LIST,
        catalogPrice: 100,
        price: 100,
      });
      await expect(
        uc.execute('plan1', { currency: 'VES' }, ASSISTANT),
      ).resolves.toMatchObject({ currency: 'VES' });
    });
  });

  describe('VES → USD: la rebaja firmada saldría del informe', () => {
    it('una rebaja firmada en VES bloquea el cambio (409) y nada cambia', async () => {
      const { uc, repo, crown } = setup('VES');
      crown({
        price: 3240,
        discountReason: DiscountReason.LOYALTY,
        discountById: ADMIN.userId,
        discountAt: NOW,
      });
      await expect(
        uc.execute('plan1', { currency: 'USD' }, ADMIN),
      ).rejects.toThrow(
        new ConflictException(CURRENCY_CHANGE_HIDES_DISCOUNT_MESSAGE),
      );
      expect((await repo.findPlanById('plan1'))!.currency).toBe('VES');
    });

    it('con la moneda del catálogo desconocida (NULL) la rebaja cuenta en las dos monedas: cambia', async () => {
      const { uc, crown } = setup('VES');
      crown({ catalogCurrency: null, price: 3240, discountById: ADMIN.userId });
      await expect(
        uc.execute('plan1', { currency: 'USD' }, ADMIN),
      ).resolves.toMatchObject({ currency: 'USD' });
    });

    it('un descuento propio (sin rebaja de precio) no depende de la moneda: cambia', async () => {
      const { uc, crown } = setup('VES');
      crown({ price: 3600, discount: 100, discountById: ADMIN.userId });
      await expect(
        uc.execute('plan1', { currency: 'USD' }, ADMIN),
      ).resolves.toMatchObject({ currency: 'USD' });
    });
  });

  it('sin cambiar de moneda (la misma, o solo notas) no se vuelve a validar nada', async () => {
    const { uc, crown } = setup('VES');
    crown({ price: 1 });
    await expect(
      uc.execute('plan1', { currency: 'VES', notes: 'x' }, ASSISTANT),
    ).resolves.toMatchObject({ currency: 'VES' });
  });
});
