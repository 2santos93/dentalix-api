import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { computePatientAging } from '../../receivables/application/compute-patient-aging';
import {
  COLLECTIONS_REPOSITORY,
  type CollectionsRepository,
} from '../domain/ports/collections-repository.port';
import {
  overdueView,
  type OverdueAmount,
  type OverdueBalance,
} from '../domain/overdue-balance';
import { COLLECTIONS_CLOCK, type CollectionsClock } from './collections-clock';
import { PlanBalanceCalculator } from '../../payments/application/plan-balance-calculator';
import {
  CURRENCY_DIGITS_CATALOG,
  roundingDigitsLookup,
  type CurrencyDigitsCatalog,
} from '../../../shared/money/currency-digits';
import { ledgerPlanBalanceInputs } from '../../receivables/application/ledger-plan-balances';

/** Roles que ven el IMPORTE vencido (dato financiero, como la cartera). */
export const OVERDUE_AMOUNT_ROLES: readonly ClinicRole[] = [
  ClinicRole.ADMIN,
  ClinicRole.RECEPTION,
];

/** La marca de vencido y el saldo pendiente por moneda de un paciente. */
export interface PatientBalanceView {
  overdue: OverdueBalance;
  pending: OverdueAmount[];
}

/**
 * Marca «Saldo vencido» de un LOTE de pacientes (DX-150): la agenda pide la de
 * todos los pacientes de sus tarjetas a la vez. Número FIJO de consultas
 * (resumen `patient_ledgers` por clave primaria + zonas de las sedes), sin
 * importar cuántas citas haya: sin N+1. El saldo es el de la cartera (DX-145),
 * con lo abonado en otra moneda convertido (DX-472-bis).
 */
@Injectable()
export class PatientBalanceFlags {
  private readonly logger = new Logger('Collections');

  constructor(
    @Inject(COLLECTIONS_REPOSITORY)
    private readonly repo: CollectionsRepository,
    @Inject(COLLECTIONS_CLOCK) private readonly now: CollectionsClock,
    private readonly planBalance: PlanBalanceCalculator,
    // B4 (DX-472-bis): decimales de cada moneda para los estados de cuota.
    @Optional()
    @Inject(CURRENCY_DIGITS_CATALOG)
    private readonly currencyDigits?: CurrencyDigitsCatalog,
  ) {}

  async forPatients(
    patientIds: readonly string[],
    role: ClinicRole | null,
  ): Promise<Map<string, OverdueBalance>> {
    const views = await this.viewsForPatients(patientIds, role);
    return new Map([...views].map(([id, v]) => [id, v.overdue]));
  }

  /**
   * La marca de `forPatients` y, además, el saldo PENDIENTE por moneda (lo que
   * se debe menos el saldo a favor, solo si es positivo; DX-224 «¿Quién
   * llama?»). Como el importe vencido, el pendiente solo lo ven ADMIN y
   * RECEPTION (`pending` vacío para los demás). Las mismas consultas que
   * `forPatients`: la antigüedad se calcula una vez.
   */
  async viewsForPatients(
    patientIds: readonly string[],
    role: ClinicRole | null,
  ): Promise<Map<string, PatientBalanceView>> {
    const out = new Map<string, PatientBalanceView>();
    const ids = [...new Set(patientIds)];
    for (const id of ids) {
      out.set(id, { overdue: overdueView(undefined, false), pending: [] });
    }
    if (ids.length === 0) return out;
    const ledgers = await this.repo.ledgersOf(ids);
    if (ledgers.length === 0) return out;
    const zoneOf = await this.repo.locationTimeZones();
    // DX-472-bis: lo abonado en otra moneda cuenta convertido, como en la
    // cartera, pero SIN red (revisión M1): la agenda no espera al proveedor.
    // Un abono que necesitaría la tasa de su día (anterior a DX-375 sin
    // congelar) no suma ni deja nada vencido, y la marca lo dice
    // (`incomplete`). Si algo de esto falla, la marca se calcula como antes,
    // sin convertir: la lista de citas nunca cae por las tasas.
    const [planBalances, roundingDigitsOf] = await Promise.all([
      Promise.resolve()
        .then(() =>
          this.planBalance.computeMany(
            ledgerPlanBalanceInputs(ledgers, zoneOf),
            { offline: true },
          ),
        )
        .catch((error: unknown) => {
          this.logger.warn({
            event: 'collections.balance_flags_unconverted',
            error: error instanceof Error ? error.name : 'unknown',
          });
          return undefined;
        }),
      roundingDigitsLookup(
        this.currencyDigits,
        ledgers.flatMap((l) => l.plans.map((p) => p.currency)),
      ).catch(() => undefined),
    ]);
    const now = this.now();
    const withAmounts = role !== null && OVERDUE_AMOUNT_ROLES.includes(role);
    for (const ledger of ledgers) {
      const timeZone = zoneOf(ledger.locationId);
      const aging = computePatientAging(ledger, {
        now,
        timeZone,
        planBalances,
        roundingDigitsOf,
      });
      out.set(ledger.patientId, {
        overdue: overdueView(aging, withAmounts),
        pending: withAmounts
          ? aging.currencies
              .filter((c) => c.balance > 0)
              .map((c) => ({ currency: c.currency, amount: c.balance }))
          : [],
      });
    }
    return out;
  }

  async forPatient(
    patientId: string,
    role: ClinicRole | null,
  ): Promise<OverdueBalance> {
    const map = await this.forPatients([patientId], role);
    return map.get(patientId) ?? overdueView(undefined, false);
  }
}
