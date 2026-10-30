import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  MANUAL_RATE_BASE_CURRENCY_MESSAGE,
  MANUAL_RATE_CURRENCY_MESSAGE,
  MANUAL_RATE_DATE_MESSAGE,
  MANUAL_RATE_DUPLICATE_MESSAGE,
  MANUAL_RATE_FUTURE_DATE_MESSAGE,
  MANUAL_RATE_MESSAGE,
  MANUAL_RATE_IN_USE_MESSAGE,
  MANUAL_RATE_NOT_A_MEMBER_MESSAGE,
} from '../../domain/exchange-rate-source';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { makeManualRates } from '../__fixtures__/in-memory-exchange-settings';
import { ExchangeSourceChangeHooks } from '../exchange-source-change-hooks';
import {
  CorrectManualExchangeRateUseCase,
  ListManualExchangeRatesUseCase,
  RegisterManualExchangeRateUseCase,
} from './manual-exchange-rates.use-cases';

describe('Tasas de cambio manuales (DX-374)', () => {
  const A = '66666666-6666-4666-8666-666666666666';
  const B = '77777777-7777-4777-8777-777777777777';
  const ADMIN = 'u-admin';
  // 2026-10-30 03:00 UTC: en la sede de A (UTC-4) todavía es el 29; en la de
  // B (UTC) ya es el 30.
  const NOW = new Date(Date.UTC(2026, 9, 30, 3, 0));
  const tenantContext = new TenantContextService();
  let manual: ReturnType<typeof makeManualRates>;
  let hooks: ExchangeSourceChangeHooks;
  const register = () =>
    new RegisterManualExchangeRateUseCase(manual, () => NOW, hooks);
  const inClinic = <T>(tenant: string, fn: () => Promise<T>) =>
    tenantContext.run(tenant, fn);

  beforeEach(() => {
    hooks = new ExchangeSourceChangeHooks();
    manual = makeManualRates({}, tenantContext, {
      zones: { [A]: 'America/Caracas', [B]: 'UTC' },
      members: { [A]: [ADMIN], [B]: [ADMIN] },
    });
  });

  it('registra la tasa del día en la clínica del contexto (moneda en mayúsculas)', async () => {
    const saved = await inClinic(A, () =>
      register().execute(
        { date: '2026-10-29', currency: 'ves', rate: 36.12345678 },
        ADMIN,
      ),
    );
    expect(saved).toMatchObject({
      date: '2026-10-29',
      currency: 'VES',
      rate: 36.12345678,
    });
    expect(manual.rows(A)).toHaveLength(1);
    expect(manual.rows(B)).toHaveLength(0);
  });

  // DX-380: con la tasa del día ya registrada, los abonos sin tasa de la
  // clínica no esperan a su backoff: el barrido siguiente los congela.
  it('tras registrar la tasa avisa (en la clínica del contexto) de que cambiaron sus tasas', async () => {
    const seen: (string | undefined)[] = [];
    hooks.registerAfterRatesChange(() => {
      seen.push(tenantContext.getTenantId());
      return Promise.resolve();
    });
    await inClinic(A, () =>
      register().execute(
        { date: '2026-10-29', currency: 'VES', rate: 36 },
        ADMIN,
      ),
    );
    const duplicate = inClinic(A, () =>
      register().execute(
        { date: '2026-10-29', currency: 'VES', rate: 37 },
        ADMIN,
      ),
    );
    await expect(duplicate).rejects.toBeInstanceOf(ConflictException);
    expect(seen).toEqual([A]);
  });

  it('una tasa ya registrada para ese día y moneda no se sobrescribe: 409 en español', async () => {
    const input = { date: '2026-10-29', currency: 'VES', rate: 36 };
    await inClinic(A, () => register().execute(input, ADMIN));
    const again = inClinic(A, () =>
      register().execute({ ...input, rate: 37 }, ADMIN),
    );
    await expect(again).rejects.toBeInstanceOf(ConflictException);
    await expect(again).rejects.toThrow(MANUAL_RATE_DUPLICATE_MESSAGE);
    expect(manual.rows(A).map((r) => r.rate)).toEqual([36]);
  });

  it('la misma moneda y día en OTRA clínica sí se registra', async () => {
    const input = { date: '2026-10-29', currency: 'VES', rate: 36 };
    await inClinic(A, () => register().execute(input, ADMIN));
    await expect(
      inClinic(B, () => register().execute({ ...input, rate: 40 }, ADMIN)),
    ).resolves.toMatchObject({ rate: 40 });
  });

  it('«hoy» es el de la zona de la sede: el 30 aún es futuro en la sede de A, pero no en la de B', async () => {
    const future = inClinic(A, () =>
      register().execute(
        { date: '2026-10-30', currency: 'VES', rate: 36 },
        ADMIN,
      ),
    );
    await expect(future).rejects.toBeInstanceOf(BadRequestException);
    await expect(future).rejects.toThrow(MANUAL_RATE_FUTURE_DATE_MESSAGE);
    await expect(
      inClinic(B, () =>
        register().execute(
          { date: '2026-10-30', currency: 'VES', rate: 36 },
          ADMIN,
        ),
      ),
    ).resolves.toMatchObject({ date: '2026-10-30' });
  });

  it.each([
    ['0', 0],
    ['negativa', -1],
    ['con 9 decimales', 1.123456789],
    ['demasiado grande', 10_000_000],
    ['NaN', Number.NaN],
    ['infinita', Number.POSITIVE_INFINITY],
  ])('una tasa %s es 400 en español', async (_label, rate) => {
    const run = inClinic(B, () =>
      register().execute({ date: '2026-10-29', currency: 'VES', rate }, ADMIN),
    );
    await expect(run).rejects.toBeInstanceOf(BadRequestException);
    await expect(run).rejects.toThrow(MANUAL_RATE_MESSAGE);
  });

  it('acepta exactamente 8 decimales', async () => {
    await expect(
      inClinic(B, () =>
        register().execute(
          { date: '2026-10-29', currency: 'VES', rate: 0.00000001 },
          ADMIN,
        ),
      ),
    ).resolves.toMatchObject({ rate: 0.00000001 });
  });

  it('una moneda fuera de la lista de monedas es 400', async () => {
    const run = inClinic(B, () =>
      register().execute(
        { date: '2026-10-29', currency: 'ZZZ', rate: 1 },
        ADMIN,
      ),
    );
    await expect(run).rejects.toThrow(MANUAL_RATE_CURRENCY_MESSAGE);
  });

  it('USD es la base: no se registra', async () => {
    const run = inClinic(B, () =>
      register().execute(
        { date: '2026-10-29', currency: 'USD', rate: 1 },
        ADMIN,
      ),
    );
    await expect(run).rejects.toBeInstanceOf(BadRequestException);
    await expect(run).rejects.toThrow(MANUAL_RATE_BASE_CURRENCY_MESSAGE);
  });

  it.each(['2026-02-30', '2026-7-1', '29/10/2026', '1999-12-31', ''])(
    'una fecha inválida o fuera de rango (%s) es 400',
    async (date) => {
      const run = inClinic(B, () =>
        register().execute({ date, currency: 'VES', rate: 1 }, ADMIN),
      );
      await expect(run).rejects.toBeInstanceOf(BadRequestException);
      await expect(run).rejects.toThrow(MANUAL_RATE_DATE_MESSAGE);
    },
  );

  it('quien no es miembro vivo de la clínica (acceso de soporte) recibe 403', async () => {
    const run = inClinic(B, () =>
      register().execute(
        { date: '2026-10-29', currency: 'VES', rate: 1 },
        'u-soporte',
      ),
    );
    await expect(run).rejects.toBeInstanceOf(ForbiddenException);
    await expect(run).rejects.toThrow(MANUAL_RATE_NOT_A_MEMBER_MESSAGE);
  });

  it('la lista trae las últimas de la clínica, del día más reciente al más antiguo', async () => {
    for (const [date, currency] of [
      ['2026-10-27', 'VES'],
      ['2026-10-29', 'VES'],
      ['2026-10-29', 'COP'],
    ]) {
      await inClinic(B, () =>
        register().execute({ date, currency, rate: 2 }, ADMIN),
      );
    }
    await inClinic(A, () =>
      register().execute(
        { date: '2026-10-28', currency: 'EUR', rate: 1 },
        ADMIN,
      ),
    );
    const list = await inClinic(B, () =>
      new ListManualExchangeRatesUseCase(manual).execute({}),
    );
    expect(list.map((r) => `${r.date} ${r.currency}`)).toEqual([
      '2026-10-29 COP',
      '2026-10-29 VES',
      '2026-10-27 VES',
    ]);
    const limited = await inClinic(B, () =>
      new ListManualExchangeRatesUseCase(manual).execute({ limit: 1 }),
    );
    expect(limited).toHaveLength(1);
  });
});

// DX-375: corregir una tasa manual que ningún abono usó; una ya usada (algún
// abono la congeló) no se cambia: 409 en español.
describe('Corregir una tasa manual (DX-375)', () => {
  const A = '88888888-8888-4888-8888-888888888888';
  const B = '99999999-9999-4999-8999-999999999999';
  const tenantContext = new TenantContextService();
  let manual: ReturnType<typeof makeManualRates>;
  const hooks = new ExchangeSourceChangeHooks();
  const woken: (string | undefined)[] = [];
  hooks.registerAfterRatesChange(() => {
    woken.push(tenantContext.getTenantId());
    return Promise.resolve();
  });
  const correct = () => new CorrectManualExchangeRateUseCase(manual, hooks);
  const inClinic = <T>(tenant: string, fn: () => Promise<T>) =>
    tenantContext.run(tenant, fn);
  const idOf = (tenant: string, currency: string) =>
    manual.rows(tenant).find((r) => r.currency === currency)?.id ?? '';

  beforeEach(() => {
    manual = makeManualRates(
      {
        [A]: { '2026-10-29': { VES: 36, EUR: 0.9 } },
        [B]: { '2026-10-29': { VES: 40 } },
      },
      tenantContext,
    );
  });

  it('corrige una tasa sin usar y la lista la marca como no usada', async () => {
    const saved = await inClinic(A, () =>
      correct().execute(idOf(A, 'VES'), { rate: 36.5 }),
    );
    expect(saved).toMatchObject({ currency: 'VES', rate: 36.5, inUse: false });
    expect(manual.rows(B)[0].rate).toBe(40);
    // DX-380: la corrección adelanta los reintentos de la clínica.
    expect(woken).toEqual([A]);
  });

  it('una tasa que ya usa un abono responde 409 y no cambia', async () => {
    manual.markUsed(A, '2026-10-29', 'VES');
    const run = inClinic(A, () =>
      correct().execute(idOf(A, 'VES'), { rate: 37 }),
    );
    await expect(run).rejects.toBeInstanceOf(ConflictException);
    await expect(run).rejects.toMatchObject({
      response: {
        code: 'MANUAL_EXCHANGE_RATE_IN_USE',
        message: MANUAL_RATE_IN_USE_MESSAGE,
      },
    });
    expect(manual.rows(A).find((r) => r.currency === 'VES')?.rate).toBe(36);
    const list = await inClinic(A, () =>
      new ListManualExchangeRatesUseCase(manual).execute({}),
    );
    expect(list.map((r) => [r.currency, r.inUse])).toEqual([
      ['EUR', false],
      ['VES', true],
    ]);
  });

  it('una tasa de otra clínica es 404', async () => {
    await expect(
      inClinic(A, () => correct().execute(idOf(B, 'VES'), { rate: 41 })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([0, -1, 1.123456789, Number.NaN])(
    'rechaza la tasa %p con 400 en español',
    async (rate) => {
      await expect(
        inClinic(A, () => correct().execute(idOf(A, 'VES'), { rate })),
      ).rejects.toMatchObject({
        response: { message: MANUAL_RATE_MESSAGE, field: 'rate' },
      });
    },
  );
});
