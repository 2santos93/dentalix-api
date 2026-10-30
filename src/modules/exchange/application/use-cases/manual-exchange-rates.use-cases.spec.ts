import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  MANUAL_RATE_BASE_CURRENCY_MESSAGE,
  MANUAL_RATE_CURRENCY_MESSAGE,
  MANUAL_RATE_DATE_MESSAGE,
  MANUAL_RATE_DUPLICATE_MESSAGE,
  MANUAL_RATE_FUTURE_DATE_MESSAGE,
  MANUAL_RATE_MESSAGE,
  MANUAL_RATE_NOT_A_MEMBER_MESSAGE,
} from '../../domain/exchange-rate-source';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { makeManualRates } from '../__fixtures__/in-memory-exchange-settings';
import {
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
  const register = () =>
    new RegisterManualExchangeRateUseCase(manual, () => NOW);
  const inClinic = <T>(tenant: string, fn: () => Promise<T>) =>
    tenantContext.run(tenant, fn);

  beforeEach(() => {
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
