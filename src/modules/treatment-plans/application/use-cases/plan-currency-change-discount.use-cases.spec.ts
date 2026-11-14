import { ConflictException } from '@nestjs/common';
import { ClinicRole, PriceSource, TreatmentPlanStatus } from '@prisma/client';
import {
  CURRENCY_LOCKED_BY_PRICED_ITEMS_CODE,
  CURRENCY_LOCKED_BY_PRICED_ITEMS_MESSAGE,
  UpdateTreatmentPlanUseCase,
} from './update-treatment-plan.use-case';
import { InMemoryTreatmentPlanRepository } from './__fixtures__/in-memory-treatment-plan.repository';
import { testDiscountPolicy } from './__fixtures__/discount-fixtures';
import type { CurrencyWhitelist } from '../../domain/ports/currency-whitelist.port';

// DX-513-bis §5.6 (test 14): la referencia de cada ítem, y su foto
// convertida, están en la moneda del plan de cuando se escribió. Un plan con
// algún ítem vivo con precio de referencia ya no cambia de moneda: 409
// PLAN_CURRENCY_LOCKED_BY_PRICED_ITEMS en los dos sentidos, también con
// convenio (cierra R1 de DX-513) y con lista de precios (cierra R2: sus
// importes ya no se reetiquetan). Así ya no hay rebaja que pueda aparecer
// sin firmar o desaparecer del informe al cambiar la moneda (H1). Los ítems
// libres no bloquean. Clínica con el catálogo en VES (3.600,00 VES).
const NOW = new Date('2026-10-16T15:00:00.000Z');
const ASSISTANT = { role: ClinicRole.ASSISTANT, userId: 'u-asis' };
const ADMIN = { role: ClinicRole.ADMIN, userId: 'u-admin' };

const whitelist: CurrencyWhitelist = {
  has: (code: string) => Promise.resolve(['USD', 'VES'].includes(code)),
};

const LOCKED = new ConflictException({
  statusCode: 409,
  error: 'Conflict',
  code: CURRENCY_LOCKED_BY_PRICED_ITEMS_CODE,
  message: CURRENCY_LOCKED_BY_PRICED_ITEMS_MESSAGE,
});

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

describe('un plan con ítems con referencia no cambia de moneda (DX-513-bis, test 14)', () => {
  it.each([
    ['USD', 'VES'],
    ['VES', 'USD'],
  ] as const)(
    '%s → %s con un ítem de catálogo: 409 con el código y nada cambia',
    async (from, to) => {
      const { uc, repo, crown } = setup(from);
      crown({ price: 1 });
      await expect(
        uc.execute('plan1', { currency: to }, ADMIN),
      ).rejects.toThrow(LOCKED);
      await expect(
        uc.execute('plan1', { currency: to }, ADMIN),
      ).rejects.toMatchObject({
        response: { code: CURRENCY_LOCKED_BY_PRICED_ITEMS_CODE },
      });
      expect((await repo.findPlanById('plan1'))!.currency).toBe(from);
    },
  );

  it('también sin ninguna rebaja (precio igual al de catálogo): la foto está en la moneda actual', async () => {
    const { uc, crown } = setup('VES');
    crown({ referenceCurrency: 'VES', referencePriceInPlan: 3600 });
    await expect(
      uc.execute('plan1', { currency: 'USD' }, ADMIN),
    ).rejects.toThrow(LOCKED);
  });

  it('con un ítem de convenio (cierra R1): 409', async () => {
    const { uc, crown } = setup('VES');
    crown({
      priceSource: PriceSource.AGREEMENT_PERCENT,
      agreementId: 'ag1',
      agreementName: 'Convenio 10',
      catalogPrice: 3240,
      price: 3240,
    });
    await expect(
      uc.execute('plan1', { currency: 'USD' }, ADMIN),
    ).rejects.toThrow(LOCKED);
  });

  it('con un ítem de lista de precios (cierra R2: nada se reetiqueta sin convertir): 409', async () => {
    const { uc, crown } = setup('USD');
    crown({
      priceSource: PriceSource.PRICE_LIST,
      catalogPrice: 100,
      price: 100,
    });
    await expect(
      uc.execute('plan1', { currency: 'VES' }, ASSISTANT),
    ).rejects.toThrow(LOCKED);
  });

  it('con la moneda del catálogo desconocida (NULL): también 409', async () => {
    const { uc, crown } = setup('USD');
    crown({ catalogCurrency: null });
    await expect(
      uc.execute('plan1', { currency: 'VES' }, ADMIN),
    ).rejects.toThrow(LOCKED);
  });

  it('un plan solo con ítems libres (sin referencia) cambia de moneda', async () => {
    const { uc, crown } = setup('USD');
    crown({
      catalogPrice: null,
      basePrice: null,
      catalogCurrency: null,
      priceSource: null,
      price: 50,
    });
    await expect(
      uc.execute('plan1', { currency: 'VES' }, ASSISTANT),
    ).resolves.toMatchObject({ currency: 'VES' });
  });

  it('un ítem con referencia ya retirado no bloquea', async () => {
    const { uc, crown } = setup('USD');
    crown({ deletedAt: new Date('2026-10-01T00:00:00Z') });
    await expect(
      uc.execute('plan1', { currency: 'VES' }, ASSISTANT),
    ).resolves.toMatchObject({ currency: 'VES' });
  });

  it('sin cambiar de moneda (la misma, o solo notas) no bloquea', async () => {
    const { uc, crown } = setup('VES');
    crown({ price: 1 });
    await expect(
      uc.execute('plan1', { currency: 'VES', notes: 'x' }, ASSISTANT),
    ).resolves.toMatchObject({ currency: 'VES', notes: 'x' });
  });

  it('el abono va antes: un plan con abonos responde su 409 de siempre', async () => {
    const { uc, repo, crown } = setup('USD');
    crown();
    repo.livePaymentPlanIds.add('plan1');
    await expect(
      uc.execute('plan1', { currency: 'VES' }, ADMIN),
    ).rejects.toThrow(/abonos registrados/);
  });
});
