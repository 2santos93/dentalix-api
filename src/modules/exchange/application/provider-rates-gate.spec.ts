import { Logger } from '@nestjs/common';
import {
  ExchangeRateBudgetExceededError,
  ExchangeRateUnavailableError,
} from '../domain/ports/exchange-rate-provider.port';
import {
  DEFAULT_PROVIDER_RATES_LIMITS,
  loadProviderRatesLimits,
  providerRatesLimitsProblems,
  ProviderRatesGate,
  type ProviderRatesLimits,
} from './provider-rates-gate';
import { InMemoryProviderRatesBudget } from './provider-rates-budget';

const HOUR = 60 * 60_000;
const A = { kind: 'CLINIC', tenantId: 'clinica-a' } as const;
const B = { kind: 'CLINIC', tenantId: 'clinica-b' } as const;
const PREFETCH = { kind: 'PREFETCH' } as const;
const SWEEP_A = { kind: 'SWEEP', tenantId: 'clinica-a' } as const;
const DAY = 24 * HOUR;

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

/**
 * Sin reserva del barrido salvo que el test la pida: así el global de los
 * tests de SEC-054 es entero de las peticiones.
 */
function setup(
  limits: Partial<ProviderRatesLimits> = {},
  createdAt: Record<string, Date> = {},
) {
  const clock = fixedClock();
  const all = {
    ...DEFAULT_PROVIDER_RATES_LIMITS,
    sweep: { reserve: 0, clinicLimit: 10 },
    ...limits,
  };
  const gate = new ProviderRatesGate(
    all,
    clock.now,
    new InMemoryProviderRatesBudget(
      all,
      clock.now,
      (tenantId) => createdAt[tenantId] ?? null,
    ),
  );
  return { gate, clock };
}

/** Deja correr el gasto del presupuesto (asíncrono) hasta llegar a `load`. */
const settle = () => new Promise((r) => setImmediate(r));

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
      await settle();
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
      await settle();
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
      // Ventana fija (SEC-058): la hora en curso acaba en 1 h − 3 min.
      expect((error as ExchangeRateBudgetExceededError).retryAfterSeconds).toBe(
        57 * 60,
      );
      expect(load).toHaveBeenCalledTimes(3);

      // Otra clínica tiene su propio presupuesto.
      await gate.fetch('2026-10-04', B, load);
      expect(load).toHaveBeenCalledTimes(4);

      // En la hora siguiente hay hueco otra vez.
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

  describe('cupos de SEC-058', () => {
    /** `n` días distintos (desde el 2000, como la ventana abierta del ataque). */
    const days = (n: number, from = 0) =>
      Array.from({ length: n }, (_, i) =>
        new Date(Date.UTC(2000, 0, 3 + from + i)).toISOString().slice(0, 10),
      );

    it('una clínica no pasa de su cupo diario aunque cambie de hora; las demás siguen', async () => {
      const { gate, clock } = setup({
        clinic: { limit: 3, windowMs: HOUR },
        clinicDaily: 5,
      });
      const load = ok();
      for (const [i, day] of days(5).entries()) {
        if (i === 3) clock.advance(HOUR);
        await gate.fetch(day, A, load);
      }
      clock.advance(HOUR);
      const error = await gate
        .fetch(days(1, 5)[0], A, load)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ExchangeRateBudgetExceededError);
      expect((error as ExchangeRateBudgetExceededError).scope).toBe('CLINIC');
      // El día UTC acaba a medianoche: desde las 14:00, 10 h.
      expect((error as ExchangeRateBudgetExceededError).retryAfterSeconds).toBe(
        10 * 3600,
      );
      await expect(gate.fetch(days(1, 5)[0], B, load)).resolves.toBeDefined();
      expect(load).toHaveBeenCalledTimes(6);
    });

    it('avisa una vez, en la llamada que llena el cupo diario de la clínica', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      const { gate } = setup({ clinicDaily: 2 });
      for (const day of days(2)) await gate.fetch(day, A, ok());
      await gate.fetch(days(1, 2)[0], A, ok()).catch(() => undefined);
      const quotaWarnings = warn.mock.calls.filter(
        ([entry]) =>
          (entry as { event?: string }).event ===
          'exchange.provider_clinic_quota_exhausted',
      );
      expect(quotaWarnings).toEqual([
        [
          {
            event: 'exchange.provider_clinic_quota_exhausted',
            tenantId: 'clinica-a',
            caller: 'CLINIC',
            quota: 'DAY',
            newClinic: false,
            limit: 2,
            windowMs: DAY,
          },
        ],
      ]);
      warn.mockRestore();
    });

    it('una clínica de menos de N días tiene el tope reducido; pasados, el normal', async () => {
      const { gate, clock } = setup(
        { clinicDaily: 6, newClinic: { days: 30, limit: 2 } },
        {
          'clinica-a': new Date(
            Date.parse('2026-10-30T12:00:00.000Z') - 29 * DAY,
          ),
        },
      );
      const load = ok();
      for (const day of days(2)) await gate.fetch(day, A, load);
      await expect(gate.fetch(days(1, 2)[0], A, load)).rejects.toBeInstanceOf(
        ExchangeRateBudgetExceededError,
      );
      // B no tiene alta conocida: cuenta como antigua.
      for (const day of days(3, 10)) await gate.fetch(day, B, load);

      clock.advance(DAY);
      for (const day of days(6, 20)) await gate.fetch(day, A, load);
      await expect(gate.fetch(days(1, 26)[0], A, load)).rejects.toBeInstanceOf(
        ExchangeRateBudgetExceededError,
      );
    });

    it('el barrido conserva su reserva aunque las peticiones agoten el resto', async () => {
      const { gate } = setup({
        clinic: { limit: 100, windowMs: HOUR },
        clinicDaily: 100,
        global: { limit: 5, windowMs: DAY },
        sweep: { reserve: 2, clinicLimit: 2 },
      });
      const load = ok();
      for (const day of days(3)) await gate.fetch(day, A, load);
      const error = await gate
        .fetch(days(1, 3)[0], B, load)
        .catch((e: unknown) => e);
      expect((error as ExchangeRateBudgetExceededError).scope).toBe('GLOBAL');
      await expect(
        gate.fetch(days(1, 3)[0], { kind: 'PLATFORM' }, load),
      ).rejects.toBeInstanceOf(ExchangeRateBudgetExceededError);

      await gate.fetch(days(1, 3)[0], SWEEP_A, load);
      await gate.fetch(days(1, 4)[0], SWEEP_A, load);
      expect(load).toHaveBeenCalledTimes(5);
      // El global entero ya está gastado: ni el barrido pasa de él.
      await expect(
        gate.fetch(
          days(1, 5)[0],
          { kind: 'SWEEP', tenantId: 'clinica-b' },
          load,
        ),
      ).rejects.toBeInstanceOf(ExchangeRateBudgetExceededError);
    });

    it('el barrido de una clínica no se lleva toda la reserva', async () => {
      const { gate } = setup({
        global: { limit: 10, windowMs: DAY },
        sweep: { reserve: 4, clinicLimit: 2 },
      });
      const load = ok();
      for (const day of days(2)) await gate.fetch(day, SWEEP_A, load);
      const error = await gate
        .fetch(days(1, 2)[0], SWEEP_A, load)
        .catch((e: unknown) => e);
      expect((error as ExchangeRateBudgetExceededError).scope).toBe('CLINIC');
      await expect(
        gate.fetch(
          days(1, 2)[0],
          { kind: 'SWEEP', tenantId: 'clinica-b' },
          load,
        ),
      ).resolves.toBeDefined();
    });

    it('quien esperaba un día que no entró por el cupo de otra clínica lo pide con el suyo', async () => {
      const { gate } = setup({ clinicDaily: 1 });
      await gate.fetch('2000-01-01', A, ok());
      const load = ok({ COP: 3900 });
      const [fromA, fromB] = await Promise.allSettled([
        gate.fetch('2000-02-01', A, load),
        gate.fetch('2000-02-01', B, load),
      ]);
      expect(fromA.status).toBe('rejected');
      expect(fromB).toEqual({ status: 'fulfilled', value: { COP: 3900 } });
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('un día que otra réplica ya guardó no gasta cupo ni llama', async () => {
      const { gate } = setup({ clinicDaily: 1 });
      const load = ok();
      const stored = jest.fn(() => Promise.resolve({ COP: 3950 }));
      await expect(gate.fetch('2000-03-01', A, load, stored)).resolves.toEqual({
        COP: 3950,
      });
      expect(load).not.toHaveBeenCalled();
      // El cupo diario (1) sigue entero para un día sin guardar.
      await expect(
        gate.fetch('2000-03-02', A, load, () => Promise.resolve(null)),
      ).resolves.toEqual({ COP: 4000 });
      expect(load).toHaveBeenCalledTimes(1);
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
            EXCHANGE_PROVIDER_CLINIC_DAILY_LIMIT: '20',
            EXCHANGE_PROVIDER_NEW_CLINIC_DAYS: '7',
            EXCHANGE_PROVIDER_NEW_CLINIC_LIMIT: '2',
            EXCHANGE_PROVIDER_GLOBAL_LIMIT: '50',
            EXCHANGE_PROVIDER_GLOBAL_WINDOW_MS: '3600000',
            EXCHANGE_PROVIDER_SWEEP_RESERVE: '10',
            EXCHANGE_PROVIDER_SWEEP_CLINIC_LIMIT: '3',
          }),
        ),
      ).toEqual({
        negativeTtlMs: 60_000,
        clinic: { limit: 5, windowMs: 120_000 },
        clinicDaily: 20,
        newClinic: { days: 7, limit: 2 },
        global: { limit: 50, windowMs: HOUR },
        sweep: { reserve: 10, clinicLimit: 3 },
      });
    });

    it('al arrancar, explica en español los topes que no cuadran entre sí', () => {
      expect(providerRatesLimitsProblems(envOf({}))).toEqual([]);
      const problems = providerRatesLimitsProblems(
        envOf({
          EXCHANGE_PROVIDER_GLOBAL_LIMIT: '50',
          EXCHANGE_PROVIDER_SWEEP_RESERVE: '50',
          EXCHANGE_PROVIDER_NEW_CLINIC_LIMIT: '60',
        }),
      );
      expect(problems.join(' ')).toContain(
        'EXCHANGE_PROVIDER_SWEEP_RESERVE (50) debe ser menor que EXCHANGE_PROVIDER_GLOBAL_LIMIT (50)',
      );
      expect(problems.join(' ')).toContain(
        'EXCHANGE_PROVIDER_NEW_CLINIC_LIMIT',
      );
      expect(
        providerRatesLimitsProblems(
          envOf({ EXCHANGE_PROVIDER_SWEEP_CLINIC_LIMIT: 'diez' }),
        ),
      ).toEqual([
        'EXCHANGE_PROVIDER_SWEEP_CLINIC_LIMIT debe ser un entero entre 1 y 100000 (recibido "diez").',
      ]);
    });

    it('rechaza un valor que no es un entero positivo', () => {
      expect(() =>
        loadProviderRatesLimits(envOf({ EXCHANGE_PROVIDER_CLINIC_LIMIT: '0' })),
      ).toThrow('EXCHANGE_PROVIDER_CLINIC_LIMIT');
    });
  });
});
