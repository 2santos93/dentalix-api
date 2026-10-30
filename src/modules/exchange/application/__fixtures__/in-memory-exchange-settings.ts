import type { ExchangeRateSource } from '../../domain/exchange-rate-source';
import type {
  ClinicExchangeSettings,
  ClinicExchangeSettingsRepository,
  ClinicProviderWindow,
} from '../../domain/ports/clinic-exchange-settings-repository.port';
import {
  ManualExchangeRateAuthorError,
  ManualExchangeRateInUseError,
  ManualExchangeRateNotFoundError,
  ManualExchangeRateTakenError,
  type ManualExchangeRateRepository,
  type NewManualExchangeRate,
} from '../../domain/ports/manual-exchange-rate-repository.port';
import type { ManualExchangeRate } from '../../domain/entities/manual-exchange-rate.entity';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';

const NO_TENANT = 'sin-tenant';

function tenantOf(ctx: TenantContextService): string {
  return ctx.getTenantId() ?? NO_TENANT;
}

/**
 * Ajustes de tasa de cada clínica en memoria, por tenant del contexto (como
 * la fila de `tenants`). Una clínica sin entrada está en AUTOMATIC, el
 * default; dar solo `'MANUAL'` es MANUAL desde 2000-01-01 (todo día manual).
 */
export function makeSettings(
  initial: Record<string, ExchangeRateSource | ClinicExchangeSettings>,
  ctx: TenantContextService = new TenantContextService(),
  options: {
    zones?: Record<string, string>;
    /** SEC-054: ventana del proveedor de cada clínica (por defecto, desde 2000). */
    windows?: Record<string, ClinicProviderWindow>;
  } = {},
): ClinicExchangeSettingsRepository & {
  settingsOf(tenantId: string): ClinicExchangeSettings;
  reads(): number;
} {
  const AUTOMATIC: ClinicExchangeSettings = {
    source: 'AUTOMATIC',
    manualSince: null,
  };
  const store = new Map<string, ClinicExchangeSettings>(
    Object.entries(initial).map(([tenant, value]) => [
      tenant,
      typeof value === 'string'
        ? {
            source: value,
            manualSince: value === 'MANUAL' ? '2000-01-01' : null,
          }
        : value,
    ]),
  );
  let reads = 0;
  const current = (tenant: string) => store.get(tenant) ?? AUTOMATIC;
  return {
    settingsOf: current,
    reads: () => reads,
    get: () => {
      reads += 1;
      return Promise.resolve({ ...current(tenantOf(ctx)) });
    },
    set: (next) => {
      const tenant = tenantOf(ctx);
      const before = current(tenant);
      const after = next({ ...before });
      store.set(tenant, after);
      return Promise.resolve({ before, after });
    },
    principalTimeZone: () =>
      Promise.resolve(options.zones?.[tenantOf(ctx)] ?? 'UTC'),
    providerWindow: () =>
      Promise.resolve(
        options.windows?.[tenantOf(ctx)] ?? {
          since: new Date('2000-01-01T00:00:00.000Z'),
          timeZones: [options.zones?.[tenantOf(ctx)] ?? 'UTC'],
        },
      ),
  };
}

interface ManualOptions {
  /** Monedas de `currencies`. */
  currencies?: readonly string[];
  /** Zona de la sede de referencia de cada clínica. */
  zones?: Record<string, string>;
  /** Usuarios que son miembros vivos de cada clínica. */
  members?: Record<string, readonly string[]>;
}

/**
 * Tasas manuales en memoria por clínica del contexto, con la unicidad (día,
 * moneda) y la pertenencia del autor que garantiza la BD.
 */
export function makeManualRates(
  initial: Record<string, Record<string, Record<string, number>>>,
  ctx: TenantContextService = new TenantContextService(),
  options: ManualOptions = {},
): ManualExchangeRateRepository & {
  rows(tenantId: string): ManualExchangeRate[];
  /** Un abono congeló la tasa de ese día y moneda (DX-375). */
  markUsed(tenantId: string, date: string, currency: string): void;
} {
  const store = new Map<string, ManualExchangeRate[]>();
  const used = new Set<string>();
  const usedKey = (tenant: string, date: string, currency: string) =>
    `${tenant}|${date}|${currency}`;
  const withUse = (tenant: string, row: ManualExchangeRate) => ({
    ...row,
    inUse: used.has(usedKey(tenant, row.date, row.currency)),
  });
  let seq = 0;
  const add = (
    tenant: string,
    input: Omit<NewManualExchangeRate, 'createdById'> & {
      createdById?: string;
    },
  ) => {
    seq += 1;
    const row: ManualExchangeRate = {
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      date: input.date,
      currency: input.currency,
      rate: input.rate,
      createdBy: {
        userId: input.createdById ?? 'seed',
        fullName: 'Dra. Admin',
      },
      createdAt: new Date(Date.UTC(2026, 9, 30, 12, 0, seq)),
      inUse: false,
    };
    store.set(tenant, [...(store.get(tenant) ?? []), row]);
    return row;
  };
  for (const [tenant, byDay] of Object.entries(initial)) {
    for (const [date, rates] of Object.entries(byDay)) {
      for (const [currency, rate] of Object.entries(rates)) {
        add(tenant, { date, currency, rate });
      }
    }
  }
  const currencies = new Set(
    options.currencies ?? ['USD', 'COP', 'EUR', 'VES'],
  );
  return {
    rows: (tenantId) => store.get(tenantId) ?? [],
    markUsed: (tenantId, date, currency) => {
      used.add(usedKey(tenantId, date, currency));
    },
    ratesOn: (date) => {
      const out: Record<string, number> = {};
      for (const row of store.get(tenantOf(ctx)) ?? []) {
        if (row.date === date) out[row.currency] = row.rate;
      }
      return Promise.resolve(out);
    },
    listRecent: (limit) =>
      Promise.resolve(
        [...(store.get(tenantOf(ctx)) ?? [])]
          .sort((x, y) =>
            x.date === y.date
              ? x.currency.localeCompare(y.currency)
              : y.date.localeCompare(x.date),
          )
          .slice(0, limit)
          .map((row) => withUse(tenantOf(ctx), row)),
      ),
    create: (input) => {
      const tenant = tenantOf(ctx);
      const members = options.members?.[tenant];
      if (members && !members.includes(input.createdById)) {
        return Promise.reject(new ManualExchangeRateAuthorError());
      }
      if (
        (store.get(tenant) ?? []).some(
          (r) => r.date === input.date && r.currency === input.currency,
        )
      ) {
        return Promise.reject(new ManualExchangeRateTakenError());
      }
      return Promise.resolve(add(tenant, input));
    },
    correct: (id, rate) => {
      const tenant = tenantOf(ctx);
      const row = (store.get(tenant) ?? []).find((r) => r.id === id);
      if (!row) return Promise.reject(new ManualExchangeRateNotFoundError());
      if (used.has(usedKey(tenant, row.date, row.currency))) {
        return Promise.reject(new ManualExchangeRateInUseError());
      }
      row.rate = rate;
      return Promise.resolve(withUse(tenant, row));
    },
    isKnownCurrency: (code) => Promise.resolve(currencies.has(code)),
    referenceTimeZone: () =>
      Promise.resolve(options.zones?.[tenantOf(ctx)] ?? 'UTC'),
  };
}
