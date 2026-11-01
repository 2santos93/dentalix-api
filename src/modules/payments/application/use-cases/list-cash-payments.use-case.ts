import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
import type {
  CashAdjustmentGroup,
  CashRegisterGroup,
  CashRegisterPage,
  ExternalInvoiceFilter,
  ListCashRegisterParams,
  PaymentRepository,
} from '../../domain/ports/payment-repository.port';
import {
  CashCurrencyTotal,
  CashMethodTotal,
  CashPaymentMethodTotal,
  CashPaymentView,
} from '../../domain/entities/cash-payment.entity';
import {
  canVoidPayment,
  civilDateIn,
  type VoidActor,
} from '../../domain/void-window';
import {
  checkPeriodDays,
  PERIOD_DAY_OUT_OF_RANGE_MESSAGE,
} from '../../../../shared/time/civil-day';
import { PAYMENT_CLOCK, type PaymentClock } from './void-payment.use-case';
import {
  PAYMENT_METHOD_REPOSITORY,
  type PaymentMethodRepository,
} from '../../../payment-methods/domain/ports/payment-method-repository.port';
import { PAYMENT_METHOD_NOT_FOUND_MESSAGE } from '../../../payment-methods/domain/payment-method-rules';
import { toCents } from '../../../../shared/money/money';
import { adjustmentSign } from '../../../payment-methods/domain/payment-adjustments';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// Un año (bisiesto incluido), contando ambos extremos. La caja se consulta por
// día, semana o mes; un rango mayor ya no es "caja" sino un informe, y sin tope
// cualquiera podría pedir el agregado de toda la historia de la clínica.
export const MAX_RANGE_DAYS = 366;

export const INVALID_CASH_PERIOD_MESSAGE =
  'El período no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».';
export const CASH_PERIOD_TOO_LONG_MESSAGE = `El período admite como mucho ${MAX_RANGE_DAYS} días.`;

/** DX-395: tope de filas del CSV de la caja (como el de gastos). */
export const CASH_EXPORT_MAX_ROWS = 10_000;
export const CASH_EXPORT_TOO_MANY_MESSAGE = `Hay más de ${CASH_EXPORT_MAX_ROWS} abonos con esos filtros: acota el período para exportarlos.`;

// Orden de presentación del desglose por método: el del enum (efectivo
// primero, que es lo que se arquea), y los abonos sin método al final.
const METHOD_ORDER: (PaymentMethod | null)[] = [
  PaymentMethod.CASH,
  PaymentMethod.CARD,
  PaymentMethod.TRANSFER,
  PaymentMethod.OTHER,
  null,
];

export interface ListCashPaymentsInput {
  /** Primer día del período (YYYY-MM-DD), inclusive. */
  from: string;
  /** Último día del período (YYYY-MM-DD), inclusive. */
  to: string;
  method?: PaymentMethod;
  /**
   * DX-395: solo los abonos de este medio de la clínica (activo o no). Se
   * comprueba que sea de la clínica del contexto (RLS) antes de consultar.
   */
  paymentMethodId?: string;
  /** DX-515: solo los abonos con (o sin) nº de factura externa. */
  externalInvoice?: ExternalInvoiceFilter;
  page?: number;
  pageSize?: number;
}

/** DX-395: lo que el CSV de la caja necesita, sin paginar. */
export interface CashPaymentsExport {
  items: CashPaymentView[];
  from: string;
  to: string;
}

export interface CashPaymentsSummary {
  count: number;
  byCurrency: CashCurrencyTotal[];
  byMethod: CashMethodTotal[];
  /** DX-377: total por medio de pago de la clínica y moneda. */
  byPaymentMethod: CashPaymentMethodTotal[];
  /** DX-516: ajustes por medio de pago, por moneda y tipo (vacío: ninguno). */
  adjustments: CashAdjustmentGroup[];
  /** DX-516: lo cobrado por moneda (abonos ± ajustes). */
  collected: { currency: string; total: number }[];
}

export interface ListCashPaymentsOutput {
  items: CashPaymentView[];
  total: number;
  page: number;
  pageSize: number;
  from: string;
  to: string;
  scope: { location: { id: string; name: string } | null };
  summary: CashPaymentsSummary;
}

// Misma normalización que ListCatalogDirectoryUseCase / ListInventoryItemsUseCase.
function normalizePage(page?: number): number {
  if (page === undefined || !Number.isFinite(page) || page < 1) {
    return DEFAULT_PAGE;
  }
  return Math.floor(page);
}

function normalizePageSize(pageSize?: number): number {
  if (pageSize === undefined || !Number.isFinite(pageSize) || pageSize < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(pageSize), MAX_PAGE_SIZE);
}

function methodRank(method: PaymentMethod | null): number {
  return METHOD_ORDER.indexOf(method);
}

function summarize(
  groups: CashRegisterGroup[],
  adjustmentGroups: readonly CashAdjustmentGroup[] = [],
): CashPaymentsSummary {
  const currencyCents = new Map<string, { cents: number; count: number }>();
  let count = 0;

  for (const group of groups) {
    count += group.count;
    const acc = currencyCents.get(group.currency) ?? { cents: 0, count: 0 };
    acc.cents += toCents(group.total);
    acc.count += group.count;
    currencyCents.set(group.currency, acc);
  }

  const byCurrency = [...currencyCents.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, acc]) => ({
      currency,
      total: acc.cents / 100,
      count: acc.count,
    }));

  // DX-377: el repositorio agrupa también por medio, así que un método puede
  // llegar en varios grupos: se suman por (método, moneda).
  const methodCents = new Map<
    string,
    {
      method: PaymentMethod | null;
      currency: string;
      cents: number;
      count: number;
    }
  >();
  const mediumCents = new Map<
    string,
    {
      paymentMethodId: string | null;
      name: string | null;
      currency: string;
      cents: number;
      count: number;
    }
  >();
  for (const group of groups) {
    const methodKey = `${group.method ?? ''}|${group.currency}`;
    const m = methodCents.get(methodKey) ?? {
      method: group.method,
      currency: group.currency,
      cents: 0,
      count: 0,
    };
    m.cents += toCents(group.total);
    m.count += group.count;
    methodCents.set(methodKey, m);

    const medium = group.paymentMethod ?? null;
    const mediumKey = `${medium?.id ?? ''}|${group.currency}`;
    const p = mediumCents.get(mediumKey) ?? {
      paymentMethodId: medium?.id ?? null,
      name: medium?.name ?? null,
      currency: group.currency,
      cents: 0,
      count: 0,
    };
    p.cents += toCents(group.total);
    p.count += group.count;
    mediumCents.set(mediumKey, p);
  }

  const byMethod = [...methodCents.values()]
    .map((m) => ({
      method: m.method,
      currency: m.currency,
      total: m.cents / 100,
      count: m.count,
    }))
    .sort(
      (a, b) =>
        methodRank(a.method) - methodRank(b.method) ||
        a.currency.localeCompare(b.currency),
    );

  // Por nombre del medio; los abonos sin medio al final.
  const byPaymentMethod = [...mediumCents.values()]
    .map((p) => ({
      paymentMethodId: p.paymentMethodId,
      name: p.name,
      currency: p.currency,
      total: p.cents / 100,
      count: p.count,
    }))
    .sort(
      (a, b) =>
        Number(a.name === null) - Number(b.name === null) ||
        (a.name ?? '').localeCompare(b.name ?? '') ||
        a.currency.localeCompare(b.currency),
    );

  // DX-516: lo cobrado = abonos + impuestos + recargos − descuentos, por
  // moneda; sin ajustes es exactamente `byCurrency`.
  const collectedCents = new Map(
    byCurrency.map((c) => [c.currency, toCents(c.total)]),
  );
  for (const group of adjustmentGroups) {
    collectedCents.set(
      group.currency,
      (collectedCents.get(group.currency) ?? 0) +
        adjustmentSign(group.type) * toCents(group.total),
    );
  }
  const collected = [...collectedCents.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, cents]) => ({ currency, total: cents / 100 }));

  return {
    count,
    byCurrency,
    byMethod,
    byPaymentMethod,
    adjustments: [...adjustmentGroups],
    collected,
  };
}

/**
 * La CAJA de la clínica: todos los abonos de un período de días civiles —cada
 * sede corta el día a medianoche de SU zona (DX-097)—, de la sede activa (o
 * de todas sin `X-Location-Id`), con el resumen de lo cobrado por moneda y por
 * método.
 *
 * Los totales van SIN convertir, moneda por moneda. No hay una moneda base de
 * la clínica en el modelo a la que convertir, y la conversión por fecha
 * (`ConvertAmountUseCase`) depende del proveedor de tasas por cada día del
 * período: un fallo de red o una moneda sin tasa dejaría un total de caja que
 * no cuadra con el efectivo contado. Lo que se arquea es lo que entró, en la
 * moneda en que entró.
 */
@Injectable()
export class ListCashPaymentsUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY)
    private readonly repo: PaymentRepository,
    @Inject(PAYMENT_CLOCK)
    private readonly now: PaymentClock,
    @Inject(PAYMENT_METHOD_REPOSITORY)
    private readonly methods: PaymentMethodRepository,
  ) {}

  /**
   * `actor` (del token) solo decide `canVoid` de cada fila: qué abonos puede
   * anular quien consulta, con la misma regla que aplica la anulación.
   */
  async execute(
    input: ListCashPaymentsInput,
    actor: VoidActor,
  ): Promise<ListCashPaymentsOutput> {
    const { from, to } = this.period(input);
    const paymentMethod = await this.paymentMethodFilter(input.paymentMethodId);

    const page = normalizePage(input.page);
    const pageSize = normalizePageSize(input.pageSize);

    const result = await this.repo.listForCashRegister({
      from,
      to,
      method: input.method,
      paymentMethod,
      externalInvoice: input.externalInvoice,
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    return {
      items: this.viewsOf(result.items, actor),
      total: result.total,
      page,
      pageSize,
      from: input.from,
      to: input.to,
      scope: { location: result.scopeLocation },
      summary: summarize(result.groups, result.adjustmentGroups),
    };
  }

  /**
   * DX-395: todos los abonos del período con los mismos filtros, para el
   * CSV, hasta `CASH_EXPORT_MAX_ROWS` (400 en español si hay más).
   */
  async exportAll(
    input: Omit<ListCashPaymentsInput, 'page' | 'pageSize'>,
    actor: VoidActor,
  ): Promise<CashPaymentsExport> {
    const { from, to } = this.period(input);
    const paymentMethod = await this.paymentMethodFilter(input.paymentMethodId);
    const result = await this.repo.listForCashRegister({
      from,
      to,
      method: input.method,
      paymentMethod,
      externalInvoice: input.externalInvoice,
      skip: 0,
      take: CASH_EXPORT_MAX_ROWS + 1,
    });
    if (result.items.length > CASH_EXPORT_MAX_ROWS) {
      throw new BadRequestException(CASH_EXPORT_TOO_MANY_MESSAGE);
    }
    return {
      items: this.viewsOf(result.items, actor),
      from: input.from,
      to: input.to,
    };
  }

  // Días que existan (`2026-02-30` no), en el rango admitido y en orden. El
  // período se queda en días civiles: cada sede lo traduce a instantes en SU
  // zona (DX-097), en el repositorio.
  private period(input: { from: string; to: string }): {
    from: string;
    to: string;
  } {
    const period = checkPeriodDays(input.from, input.to);
    if (!period.ok) {
      throw new BadRequestException(
        period.problem === 'OUT_OF_RANGE'
          ? PERIOD_DAY_OUT_OF_RANGE_MESSAGE
          : INVALID_CASH_PERIOD_MESSAGE,
      );
    }
    if (period.days > MAX_RANGE_DAYS) {
      throw new BadRequestException(CASH_PERIOD_TOO_LONG_MESSAGE);
    }
    return { from: period.from, to: period.to };
  }

  /**
   * DX-395: el medio del filtro, leído bajo RLS (nunca se confía en el id del
   * cliente): de otra clínica o inexistente, 400. Uno inicial lleva su método
   * para contar también los abonos sin medio de una réplica anterior.
   */
  private async paymentMethodFilter(
    paymentMethodId: string | undefined,
  ): Promise<ListCashRegisterParams['paymentMethod']> {
    if (!paymentMethodId) return undefined;
    const found = await this.methods.findById(paymentMethodId);
    if (!found) throw new BadRequestException(PAYMENT_METHOD_NOT_FOUND_MESSAGE);
    return { id: found.id, legacyMethod: found.legacyMethod };
  }

  private viewsOf(
    rows: CashRegisterPage['items'],
    actor: VoidActor,
  ): CashPaymentView[] {
    const now = this.now();
    return rows.map(({ payment, voidSubject }) => {
      const registeredOn = civilDateIn(
        voidSubject.createdAt,
        voidSubject.timeZone,
      );
      return {
        ...payment,
        canVoid: canVoidPayment(voidSubject, actor, now),
        registeredOn,
        registeredToday:
          registeredOn === civilDateIn(now, voidSubject.timeZone),
      };
    });
  }
}
