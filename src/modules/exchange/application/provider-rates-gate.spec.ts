import { Logger } from '@nestjs/common';
import {
  ExchangeRateBudgetExceededError,
  ExchangeRateUnavailableError,
} from '../domain/ports/exchange-rate-provider.port';
import {
  DEFAULT_PROVIDER_RATES_LIMITS,
  loadProviderRatesLimits,
  ProviderRatesGate,
  type ProviderRatesLimits,
} from './provider-rates-gate';

const HOUR = 60 * 60_000;
const A = { kind: 'CLINIC', tenantId: 'clinica-a' } as const;
const B = { kind: 'CLINIC', tenantId: 'clinica-b' } as const;
const PREFETCH = { kind: 'PREFETCH' } as const;

/** Reloj fijo que el test adelanta a mano. */
function fixedClock(start = Date.parse('2026-10-30T12:00:00.000Z')) {
  let now = start;
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function setup(limits: Partial<ProviderRatesLimits> = {}) {
  const clock = fixedClock();
  const gate = new ProviderRatesGate(
    { ...DEFAULT_PROVIDER_RATES_LIMITS, ...limits },
    clock.now,
  );
  return { gate, clock };
}

const ok = (rates: Record<string, number> = { COP: 4000 }) =>
  jest.fn(() => Promise.resolve(rates));
const unavailable = () =>
  jest.fn(() =>
    Promise.reject(new ExchangeRateUnavailableError('HTTP 400 del proveedor')),
  );

describe('ProviderRatesGate (SEC-054)', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });
  afterAll(() => {
    Logger.overrideLogger(true);
  });

  describe('caché negativa', () => {
    it('un día que el proveedor no tiene no se vuelve a pedir durante el TTL', async () => {
      const { gate, clock } = setup({ negativeTtlMs: HOUR });
      const load = unavailable();

      await expect(gate.fetch('2026-10-01', A, load)).rejects.toBeInstanceOf(
        ExchangeRateUnavailableError,
      );
      clock.advance(HOUR - 1);
      // Otra clínica tampoco: la caché es compartida.
      await expect(gate.fetch('2026-10-01', B, load)).rejects.toBeInstanceOf(
        ExchangeRateUnavailableError,
      );
      expect(load).toHaveBeenCalledTimes(1);

      clock.advance(1);
      await expect(gate.fetch('2026-10-01', A, load)).rejects.toBeInstanceOf(
        ExchangeRateUnavailableError,
      );
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('solo vale para ese día', async () => {
      const { gate } = setup();
      await expect(
        gate.fetch('2026-10-01', A, unavailable()),
      ).rejects.toBeInstanceOf(ExchangeRateUnavailableError);
      const other = ok();
      await expect(gate.fetch('2026-10-02', A, other)).resolves.toEqual({
        COP: 4000,
      });
      expect(other).toHaveBeenCalledTimes(1);
    });

    it('un acierto de cache no gasta presupuesto', async () => {
      const { gate } = setup({ clinic: { limit: 1, windowMs: HOUR } });
      const load = unavailable();
      await expect(gate.fetch('2026-10-01', A, load)).rejects.toBeInstanceOf(
        ExchangeRateUnavailableError,
      );
      // Segunda vez: la caché negativa responde, no el presupuesto (429).
      const second = gate.fetch('2026-10-01', A, load);
      await expect(second).rejects.toBeInstanceOf(ExchangeRateUnavailableError);
      await expect(second).rejects.not.toBeInstanceOf(
        ExchangeRateBudgetExceededError,
      );
    });

    it('otro error (no «sin tasa») no se cachea', async () => {
      const { gate } = setup();
      const load = jest
        .fn()
        .mockRejectedValueOnce(new Error('caída de la BD'))
        .mockResolvedValueOnce({ COP: 1 });
      await expect(gate.fetch('2026-10-01', A, load)).rejects.toThrow(
        'caída de la BD',
      );
      await expect(gate.fetch('2026-10-01', A, load)).resolves.toEqual({
        COP: 1,
      });
    });

    it('la precarga diaria no la lee (reintenta) y un acierto la limpia', async () => {
      const { gate } = setup();
      await expect(
        gate.fetch('2026-10-30', A, unavailable()),
      ).rejects.toBeInstanceOf(ExchangeRateUnavailableError);
      const load = ok({ COP: 4100 });
      await expect(gate.fetch('2026-10-30', PREFETCH, load)).resolves.toEqual({
        COP: 4100,
      });
      expect(load).toHaveBeenCalledTimes(1);
      await expect(gate.fetch('2026-10-30', A, load)).resolves.toEqual({
        COP: 4100,
      });
      expect(load).toHaveBeenCalledTimes(2);
    });
  });

  describe('single-flight', () => {
    it('N peticiones simultáneas del mismo día hacen una sola llamada', async () => {
      const { gate } = setup({ clinic: { limit: 2, windowMs: HOUR } });
      let resolve!: (rates: Record<string, number>) => void;
      const load = jest.fn(
        () =>
          new Promise<Record<string, number>>((r) => {
            resolve = r;
          }),
      );
      const all = Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          gate.fetch('2026-10-01', i % 2 ? A : B, load),
        ),
      );
      resolve({ COP: 4000 });
      const results = await all;
      expect(load).toHaveBeenCalledTimes(1);
      expect(results.every((r) => r.COP === 4000)).toBe(true);
    });

    it('un fallo compartido lo reciben todas y deja la caché negativa', async () => {
      const { gate } = setup();
      let reject!: (error: Error) => void;
      const load = jest.fn(
        () =>
          new Promise<Record<string, number>>((_, r) => {
            reject = r;
          }),
      );
      const all = Promise.allSettled([
        gate.fetch('2026-10-01', A, load),
        gate.fetch('2026-10-01', B, load),
      ]);
      reject(new ExchangeRateUnavailableError('timeout'));
      const settled = await all;
      expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected']);
      await expect(gate.fetch('2026-10-01', A, load)).rejects.toBeInstanceOf(
        ExchangeRateUnavailableError,
      );
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('terminada la llamada, el día siguiente vuelve a llamar', async () => {
      const { gate } = setup();
      const load = ok();
      await gate.fetch('2026-10-01', A, load);
      await gate.fetch('2026-10-01', A, load);
      // El gate no es la caché positiva (lo es la tabla de snapshots): quien
      // llama la mira antes; aquí solo se comprueba que no queda «en vuelo».
      expect(load).toHaveBeenCalledTimes(2);
    });
  });

  describe('presupuesto por clínica', () => {
    it('superado el tope en la ventana: 429 sin llamar y con Retry-After', async () => {
      const { gate, clock } = setup({ clinic: { limit: 3, windowMs: HOUR } });
      const load = ok();
      for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) {
        await gate.fetch(day, A, load);
        clock.advance(60_000);
      }
      const error = await gate
        .fetch('2026-10-04', A, load)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ExchangeRateBudgetExceededError);
      expect((error as ExchangeRateBudgetExceededError).scope).toBe('CLINIC');
      // La primera llamada sale de la ventana en 1 h − 3 min.
      expect((error as ExchangeRateBudgetExceededError).retryAfterSeconds).toBe(
        57 * 60,
      );
      expect(load).toHaveBeenCalledTimes(3);

      // Otra clínica tiene su propio presupuesto.
      await gate.fetch('2026-10-04', B, load);
      expect(load).toHaveBeenCalledTimes(4);

      // Ventana deslizante: pasada la hora de la primera, hay hueco otra vez.
      clock.advance(57 * 60_000);
      await gate.fetch('2026-10-05', A, load);
      expect(load).toHaveBeenCalledTimes(5);
    });

    it('los fallos del proveedor también cuentan', async () => {
      const { gate } = setup({ clinic: { limit: 1, windowMs: HOUR } });
      await expect(
        gate.fetch('2026-10-01', A, unavailable()),
      ).rejects.toBeInstanceOf(ExchangeRateUnavailableError);
      await expect(gate.fetch('2026-10-02', A, ok())).rejects.toBeInstanceOf(
        ExchangeRateBudgetExceededError,
      );
    });
  });

  describe('presupuesto global', () => {
    it('lo agotan las clínicas juntas, y la precarga diaria sigue llamando', async () => {
      const { gate } = setup({
        clinic: { limit: 10, windowMs: HOUR },
        global: { limit: 2, windowMs: HOUR },
      });
      const load = ok();
      await gate.fetch('2026-10-01', A, load);
      await gate.fetch('2026-10-02', B, load);
      const error = await gate
        .fetch('2026-10-03', A, load)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ExchangeRateBudgetExceededError);
      expect((error as ExchangeRateBudgetExceededError).scope).toBe('GLOBAL');
      await expect(
        gate.fetch('2026-10-03', { kind: 'PLATFORM' }, load),
      ).rejects.toBeInstanceOf(ExchangeRateBudgetExceededError);

      await expect(gate.fetch('2026-10-30', PREFETCH, load)).resolves.toEqual({
        COP: 4000,
      });
      expect(load).toHaveBeenCalledTimes(3);
    });

    it('la precarga no gasta el presupuesto de los usuarios', async () => {
      const { gate } = setup({ global: { limit: 1, windowMs: HOUR } });
      const load = ok();
      await gate.fetch('2026-10-29', PREFETCH, load);
      await gate.fetch('2026-10-30', PREFETCH, load);
      await expect(gate.fetch('2026-10-01', A, load)).resolves.toEqual({
        COP: 4000,
      });
    });

    it('una clínica que ya agotó el suyo no gasta el global', async () => {
      const { gate } = setup({
        clinic: { limit: 1, windowMs: HOUR },
        global: { limit: 2, windowMs: HOUR },
      });
      const load = ok();
      await gate.fetch('2026-10-01', A, load);
      for (let i = 2; i < 9; i += 1) {
        await expect(
          gate.fetch(`2026-10-0${i}`, A, load),
        ).rejects.toBeInstanceOf(ExchangeRateBudgetExceededError);
      }
      await expect(gate.fetch('2026-10-01', B, load)).resolves.toBeDefined();
    });
  });

  describe('configuración por entorno', () => {
    const envOf = (vars: Record<string, string>) => (key: string) => vars[key];

    it('usa los valores por defecto sin variables', () => {
      expect(loadProviderRatesLimits(envOf({}))).toEqual(
        DEFAULT_PROVIDER_RATES_LIMITS,
      );
      expect(DEFAULT_PROVIDER_RATES_LIMITS.negativeTtlMs).toBe(HOUR);
      expect(DEFAULT_PROVIDER_RATES_LIMITS.clinic).toEqual({
        limit: 30,
        windowMs: HOUR,
      });
    });

    it('lee cada variable', () => {
      expect(
        loadProviderRatesLimits(
          envOf({
            EXCHANGE_NEGATIVE_CACHE_TTL_MS: '60000',
            EXCHANGE_PROVIDER_CLINIC_LIMIT: '5',
            EXCHANGE_PROVIDER_CLINIC_WINDOW_MS: '120000',
            EXCHANGE_PROVIDER_GLOBAL_LIMIT: '50',
            EXCHANGE_PROVIDER_GLOBAL_WINDOW_MS: '3600000',
          }),
        ),
      ).toEqual({
        negativeTtlMs: 60_000,
        clinic: { limit: 5, windowMs: 120_000 },
        global: { limit: 50, windowMs: HOUR },
      });
    });

    it('rechaza un valor que no es un entero positivo', () => {
      expect(() =>
        loadProviderRatesLimits(envOf({ EXCHANGE_PROVIDER_CLINIC_LIMIT: '0' })),
      ).toThrow('EXCHANGE_PROVIDER_CLINIC_LIMIT');
    });
  });
});
