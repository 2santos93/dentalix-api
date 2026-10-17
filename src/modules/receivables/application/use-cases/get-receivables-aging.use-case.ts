import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { RECEIVABLES_REPOSITORY } from '../../domain/ports/receivables-repository.port';
import type { ReceivablesRepository } from '../../domain/ports/receivables-repository.port';
import type {
  DebtorLastNote,
  DebtorPromise,
  PatientAging,
  PatientAgingCurrency,
} from '../../domain/entities/receivables.entity';
import {
  addToBuckets,
  AGING_BUCKETS,
  emptyBuckets,
  fromCents,
  toCents,
  type AgingBuckets,
} from '../../domain/aging';
import {
  computePatientAging,
  summarizeCurrencies,
} from '../compute-patient-aging';
import { civilDateIn } from '../../../../shared/time/civil-day';
import { DEFAULT_BUSINESS_HOURS_TIMEZONE } from '../../../../shared/locations/default-business-hours';
import { toWhatsAppNumber } from '../../../appointment-confirmations/application/whatsapp-phone';

export const RECEIVABLES_DEFAULT_PAGE_SIZE = 20;
export const RECEIVABLES_MAX_PAGE_SIZE = 100;
export const UNKNOWN_LOCATION_MESSAGE = 'La sede no es de esta clínica.';

// Reloj inyectable: las specs fijan "hoy"; producción usa el real.
export type ReceivablesClock = () => Date;
export const RECEIVABLES_CLOCK = Symbol('RECEIVABLES_CLOCK');

export interface ReceivablesAgingFilters {
  /** Sede de la deuda; sin ella, toda la clínica. */
  locationId?: string;
  /** Solo esta moneda (ISO 4217) en filas y totales. */
  currency?: string;
  /** Deuda mínima en alguna moneda (en la pedida, si hay `currency`). */
  minBalance?: number;
  /** Días mínimos de la deuda exigible más antigua (91 = «más de 90»). */
  minAgeDays?: number;
  /** DX-150: profesional de la última cita atendida del paciente. */
  providerId?: string;
  /** DX-150: con (true) o sin (false) compromiso de pago abierto. */
  hasPromise?: boolean;
}

export interface ReceivablesAgingInput extends ReceivablesAgingFilters {
  page?: number;
  pageSize?: number;
}

export interface AgingRowView extends PatientAging {
  patient: {
    id: string;
    fullName: string;
    phone: string | null;
    /** E.164 sin `+` para `https://wa.me/…`; `null` si el teléfono no sirve. */
    whatsApp: string | null;
  };
  /** Sede de la deuda; `null` si el paciente no tiene ninguna (ver informe). */
  locationId: string | null;
  lastPayment: { paidOn: string; amount: number; currency: string } | null;
  /** La próxima cuota por vencer, de cualquier moneda. */
  nextInstallment: { dueDate: Date; amount: number; currency: string } | null;
  /** DX-150: última gestión de cobro. */
  lastNote: DebtorLastNote | null;
  /** DX-150: último compromiso de pago (el vigente si está abierto). */
  promise: DebtorPromise | null;
}

export interface AgingTotal {
  currency: string;
  patients: number;
  balance: number;
  debt: number;
  credit: number;
  buckets: AgingBuckets;
}

export interface ReceivablesAgingPage {
  /** «Hoy» (YYYY-MM-DD) en la zona de la sede del alcance. */
  asOf: string;
  scope: { location: { id: string; name: string } | null };
  items: AgingRowView[];
  total: number;
  page: number;
  pageSize: number;
  /** Por moneda, sobre TODAS las filas filtradas (no solo la página). */
  totals: AgingTotal[];
}

interface ScopedRow {
  patientId: string;
  locationId: string | null;
  aging: PatientAging;
  /** Deuda total en centavos (clave de orden, calculada una vez). */
  debtCents: number;
}

function wholeOrDefault(
  value: number | undefined,
  fallback: number,
  min: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

function debtCents(aging: PatientAging): number {
  return aging.currencies.reduce((s, c) => s + toCents(c.debt), 0);
}

/** Más antigua primero; sin nada vencido, al final; luego más deuda. */
function byAge(a: ScopedRow, b: ScopedRow): number {
  const ageA = a.aging.oldestAgeDays ?? -1;
  const ageB = b.aging.oldestAgeDays ?? -1;
  return (
    ageB - ageA ||
    b.debtCents - a.debtCents ||
    a.patientId.localeCompare(b.patientId)
  );
}

function earliestNext(
  currencies: PatientAgingCurrency[],
): AgingRowView['nextInstallment'] {
  let best: AgingRowView['nextInstallment'] = null;
  for (const c of currencies) {
    if (
      c.nextInstallment &&
      (best === null ||
        c.nextInstallment.dueDate.getTime() < best.dueDate.getTime())
    ) {
      best = { ...c.nextInstallment, currency: c.currency };
    }
  }
  return best;
}

function totalsOf(rows: ScopedRow[]): AgingTotal[] {
  const byCurrency = new Map<
    string,
    {
      patients: number;
      balance: number;
      debt: number;
      credit: number;
      buckets: AgingBuckets;
    }
  >();
  for (const row of rows) {
    for (const c of row.aging.currencies) {
      const acc = byCurrency.get(c.currency) ?? {
        patients: 0,
        balance: 0,
        debt: 0,
        credit: 0,
        buckets: emptyBuckets(),
      };
      acc.patients += 1;
      acc.balance += toCents(c.balance);
      acc.debt += toCents(c.debt);
      acc.credit += toCents(c.credit);
      for (const bucket of AGING_BUCKETS) {
        addToBuckets(acc.buckets, bucket, c.buckets[bucket]);
      }
      byCurrency.set(c.currency, acc);
    }
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, acc]) => ({
      currency,
      patients: acc.patients,
      balance: fromCents(acc.balance),
      debt: fromCents(acc.debt),
      credit: fromCents(acc.credit),
      buckets: acc.buckets,
    }));
}

/**
 * Cartera por antigüedad (DX-145). Lee lo financiero de los pacientes de la
 * sede en un número fijo de consultas, calcula el saldo de cada uno con el
 * MISMO núcleo que el estado de cuenta (`computeBalances`) y lo reparte en
 * tramos; filtra, ordena y pagina en memoria (los totales necesitan todas las
 * filas de todos modos), y solo pide el contacto de la página.
 */
@Injectable()
export class GetReceivablesAgingUseCase {
  constructor(
    @Inject(RECEIVABLES_REPOSITORY)
    private readonly repo: ReceivablesRepository,
    @Inject(RECEIVABLES_CLOCK)
    private readonly now: ReceivablesClock,
  ) {}

  async execute(input: ReceivablesAgingInput): Promise<ReceivablesAgingPage> {
    const { rows, location, now } = await this.scopedRows(input);
    const page = wholeOrDefault(input.page, 1, 1);
    const pageSize = Math.min(
      wholeOrDefault(input.pageSize, RECEIVABLES_DEFAULT_PAGE_SIZE, 1),
      RECEIVABLES_MAX_PAGE_SIZE,
    );
    const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);
    return {
      asOf: civilDateIn(
        now,
        location?.timeZone ?? DEFAULT_BUSINESS_HOURS_TIMEZONE,
      ),
      scope: {
        location: location ? { id: location.id, name: location.name } : null,
      },
      items: await this.withDetails(pageRows),
      total: rows.length,
      page,
      pageSize,
      totals: totalsOf(rows),
    };
  }

  /** Todas las filas filtradas, en el mismo orden (para el CSV). */
  async exportRows(filters: ReceivablesAgingFilters): Promise<AgingRowView[]> {
    const { rows } = await this.scopedRows(filters);
    return this.withDetails(rows);
  }

  private async scopedRows(filters: ReceivablesAgingFilters) {
    const location = filters.locationId
      ? await this.repo.findLocation(filters.locationId)
      : null;
    if (filters.locationId && !location) {
      throw new BadRequestException(UNKNOWN_LOCATION_MESSAGE);
    }
    const [ledgers, zones] = await Promise.all([
      this.repo.loadLedgers({ locationId: location?.id }),
      this.repo.locationTimeZones(),
    ]);
    const now = this.now();
    const minAge = filters.minAgeDays ?? null;
    const minBalanceCents =
      filters.minBalance !== undefined ? toCents(filters.minBalance) : null;

    const rows: ScopedRow[] = [];
    for (const ledger of ledgers) {
      const timeZone =
        (ledger.locationId && zones.get(ledger.locationId)) ||
        DEFAULT_BUSINESS_HOURS_TIMEZONE;
      const full = computePatientAging(ledger, { now, timeZone });
      const aging = filters.currency
        ? summarizeCurrencies(
            full.currencies.filter((c) => c.currency === filters.currency),
          )
        : full;
      // Deudor = debe algo; un saldo solo a favor no es cartera.
      if (!aging.currencies.some((c) => c.debt > 0)) continue;
      if (
        minBalanceCents !== null &&
        !aging.currencies.some((c) => toCents(c.debt) >= minBalanceCents)
      ) {
        continue;
      }
      if (
        minAge !== null &&
        (aging.oldestAgeDays === null || aging.oldestAgeDays < minAge)
      ) {
        continue;
      }
      rows.push({
        patientId: ledger.patientId,
        locationId: ledger.locationId,
        aging,
        debtCents: debtCents(aging),
      });
    }
    rows.sort(byAge);
    return { rows: await this.byCollections(rows, filters), location, now };
  }

  /**
   * DX-150: filtros de cobranza sobre los deudores ya calculados; una consulta
   * por filtro, solo si se pide.
   */
  private async byCollections(
    rows: ScopedRow[],
    filters: ReceivablesAgingFilters,
  ): Promise<ScopedRow[]> {
    let out = rows;
    if (filters.providerId !== undefined && out.length > 0) {
      const ofProvider = await this.repo.patientsOfProvider(
        filters.providerId,
        out.map((r) => r.patientId),
      );
      out = out.filter((r) => ofProvider.has(r.patientId));
    }
    if (filters.hasPromise !== undefined && out.length > 0) {
      const withPromise = await this.repo.patientsWithOpenPromise(
        out.map((r) => r.patientId),
      );
      out = out.filter(
        (r) => withPromise.has(r.patientId) === filters.hasPromise,
      );
    }
    return out;
  }

  private async withDetails(rows: ScopedRow[]): Promise<AgingRowView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.patientId);
    const [debtors, collections] = await Promise.all([
      this.repo.loadDebtors(ids),
      this.repo.loadCollections(ids),
    ]);
    const details = new Map(debtors.map((d) => [d.patientId, d]));
    return rows.flatMap((row) => {
      const d = details.get(row.patientId);
      // Retirado entre las dos lecturas: no se muestra a medias.
      if (!d) return [];
      return [
        {
          ...row.aging,
          patient: {
            id: row.patientId,
            fullName: `${d.firstName} ${d.lastName}`.trim(),
            phone: d.phone,
            whatsApp: toWhatsAppNumber(d.phone, d.countryCode),
          },
          locationId: row.locationId,
          lastPayment: d.lastPayment
            ? {
                paidOn: civilDateIn(
                  d.lastPayment.paidAt,
                  d.lastPayment.timeZone,
                ),
                amount: d.lastPayment.amount,
                currency: d.lastPayment.currency,
              }
            : null,
          nextInstallment: earliestNext(row.aging.currencies),
          lastNote: collections.get(row.patientId)?.lastNote ?? null,
          promise: collections.get(row.patientId)?.promise ?? null,
        },
      ];
    });
  }
}
