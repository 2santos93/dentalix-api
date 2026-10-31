import type { ProviderRatesLimits } from './provider-rates-limits';

const DAY = 24 * 60 * 60_000;

/**
 * SEC-058: quién gasta del presupuesto de llamadas al proveedor (la precarga
 * diaria no gasta):
 * - `CLINIC`: una petición o conversión de la clínica del contexto;
 * - `SWEEP`: el barrido de reintentos de los abonos sin tasa (DX-380) de esa
 *   clínica, que gasta de su cupo reservado;
 * - `PLATFORM`: sin clínica en el contexto (un script, un job sin tenant).
 */
export type BudgetCaller =
  | { kind: 'CLINIC'; tenantId: string }
  | { kind: 'SWEEP'; tenantId: string }
  | { kind: 'PLATFORM' };

/**
 * Cupo de una clínica, la clave de su contador en
 * `exchange_provider_clinic_budgets`: `HOUR` en la ventana de clínica, `DAY`
 * (o el tope reducido de una clínica nueva) y `SWEEP` en la global.
 */
export type ClinicQuotaKind = 'HOUR' | 'DAY' | 'SWEEP';

export interface ClinicQuota {
  kind: ClinicQuotaKind;
  limit: number;
  windowMs: number;
  /** `DAY` con el tope de clínica nueva (`EXCHANGE_PROVIDER_NEW_CLINIC_*`). */
  newClinic: boolean;
}

/** Los cupos que gasta una llamada: los de su clínica y el global. */
export interface BudgetPlan {
  clinic: ClinicQuota[];
  /**
   * Hasta dónde puede llegar el contador global con esta llamada: el tope
   * entero para el barrido; el tope menos la reserva del barrido para el resto.
   */
  globalCap: number;
  globalWindowMs: number;
}

export function budgetPlan(
  caller: BudgetCaller,
  limits: ProviderRatesLimits,
  clinicCreatedAt: Date | null,
  now: Date,
): BudgetPlan {
  const { global, sweep } = limits;
  const interactiveCap = global.limit - sweep.reserve;
  if (caller.kind === 'PLATFORM') {
    return {
      clinic: [],
      globalCap: interactiveCap,
      globalWindowMs: global.windowMs,
    };
  }
  if (caller.kind === 'SWEEP') {
    return {
      clinic: [
        {
          kind: 'SWEEP',
          limit: sweep.clinicLimit,
          windowMs: global.windowMs,
          newClinic: false,
        },
      ],
      globalCap: global.limit,
      globalWindowMs: global.windowMs,
    };
  }
  const isNew =
    clinicCreatedAt !== null &&
    now.getTime() - clinicCreatedAt.getTime() < limits.newClinic.days * DAY;
  return {
    clinic: [
      { kind: 'HOUR', ...limits.clinic, newClinic: false },
      {
        kind: 'DAY',
        limit: isNew
          ? Math.min(limits.newClinic.limit, limits.clinicDaily)
          : limits.clinicDaily,
        windowMs: global.windowMs,
        newClinic: isNew,
      },
    ],
    globalCap: interactiveCap,
    globalWindowMs: global.windowMs,
  };
}

/**
 * Inicio de la ventana FIJA que contiene `now` (alineada a la época Unix,
 * igual en todas las réplicas): con 24 h, el día UTC.
 */
export function windowStart(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

/** Segundos hasta que acaba la ventana (al menos 1). */
export function secondsToWindowEnd(now: number, windowMs: number): number {
  const end = windowStart(now, windowMs) + windowMs;
  return Math.max(1, Math.ceil((end - now) / 1000));
}

export type BudgetVerdict =
  | {
      spent: true;
      /** Contador global tras esta llamada. */
      globalUsed: number;
      /** Cupos de la clínica que esta llamada acaba de llenar. */
      filled: ClinicQuota[];
    }
  | {
      spent: false;
      scope: 'CLINIC' | 'GLOBAL';
      /** El cupo de la clínica agotado (con `scope: 'CLINIC'`). */
      quota?: ClinicQuota;
      retryAfterSeconds: number;
    };

/**
 * Contadores del presupuesto. Gasta una llamada solo si cabe en TODOS los
 * cupos que tocan (los de la clínica y el global); si no, no gasta ninguno.
 */
export interface ProviderRatesBudget {
  spend(caller: BudgetCaller): Promise<BudgetVerdict>;
}

export const PROVIDER_RATES_BUDGET = Symbol('PROVIDER_RATES_BUDGET');

interface Counter {
  start: number;
  calls: number;
}

/**
 * Los contadores en memoria de UN proceso, con las mismas ventanas fijas y
 * los mismos cupos que `PrismaProviderRatesBudget` (el de la API, en la BD y
 * compartido entre réplicas). Lo usan los tests unitarios y la instancia por
 * defecto de `GetRatesForDateUseCase` fuera de Nest. Sin la BD no sabe el alta
 * de la clínica: salvo `clinicCreatedAt`, todas cuentan como antiguas.
 */
export class InMemoryProviderRatesBudget implements ProviderRatesBudget {
  private readonly counters = new Map<string, Counter>();

  constructor(
    private readonly limits: ProviderRatesLimits,
    private readonly now: () => Date,
    private readonly clinicCreatedAt: (tenantId: string) => Date | null = () =>
      null,
  ) {}

  spend(caller: BudgetCaller): Promise<BudgetVerdict> {
    const now = this.now();
    const at = now.getTime();
    const createdAt =
      caller.kind === 'PLATFORM' ? null : this.clinicCreatedAt(caller.tenantId);
    const plan = budgetPlan(caller, this.limits, createdAt, now);
    const clinic = plan.clinic.map((quota) => ({
      quota,
      counter: this.current(
        `${caller.kind === 'PLATFORM' ? '' : caller.tenantId}|${quota.kind}`,
        at,
        quota.windowMs,
      ),
    }));
    for (const { quota, counter } of clinic) {
      if (counter.calls >= quota.limit) {
        return Promise.resolve({
          spent: false,
          scope: 'CLINIC',
          quota,
          retryAfterSeconds: secondsToWindowEnd(at, quota.windowMs),
        });
      }
    }
    const global = this.current('GLOBAL', at, plan.globalWindowMs);
    if (global.calls >= plan.globalCap) {
      return Promise.resolve({
        spent: false,
        scope: 'GLOBAL',
        retryAfterSeconds: secondsToWindowEnd(at, plan.globalWindowMs),
      });
    }
    global.calls += 1;
    const filled: ClinicQuota[] = [];
    for (const { quota, counter } of clinic) {
      counter.calls += 1;
      if (counter.calls === quota.limit) filled.push(quota);
    }
    return Promise.resolve({ spent: true, globalUsed: global.calls, filled });
  }

  private current(key: string, now: number, windowMs: number): Counter {
    const start = windowStart(now, windowMs);
    let counter = this.counters.get(key);
    if (!counter || counter.start < start) {
      counter = { start, calls: 0 };
      this.counters.set(key, counter);
    }
    return counter;
  }
}
