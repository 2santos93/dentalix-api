import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
import type {
  CashRegisterGroup,
  PaymentRepository,
} from '../../domain/ports/payment-repository.port';
import {
  CashCurrencyTotal,
  CashMethodTotal,
  CashPaymentView,
} from '../../domain/entities/cash-payment.entity';
import { canVoidPayment, type VoidActor } from '../../domain/void-window';
import { PAYMENT_CLOCK, type PaymentClock } from './void-payment.use-case';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// Un año (bisiesto incluido), contando ambos extremos. La caja se consulta por
// día, semana o mes; un rango mayor ya no es "caja" sino un informe, y sin tope
// cualquiera podría pedir el agregado de toda la historia de la clínica.
export const MAX_RANGE_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;

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
  page?: number;
  pageSize?: number;
}

export interface CashPaymentsSummary {
  count: number;
  byCurrency: CashCurrencyTotal[];
  byMethod: CashMethodTotal[];
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

/**
 * `paidAt` es un día CIVIL guardado como medianoche UTC (el `type="date"` del
 * formulario de abono, ver `formatCivilDate` en la web), así que el período se
 * expresa también en días civiles y se compara en UTC: un `Date` local aquí
 * correría el día para cualquier clínica al oeste de Greenwich. Además de la
 * forma, se comprueba que el día exista: `new Date('2026-02-30')` no falla,
 * se va al 2 de marzo.
 */
function parseCivilDate(value: string, field: 'from' | 'to'): Date {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00.000Z`)
    : null;
  if (
    !date ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new BadRequestException(
      `${field} must be a valid calendar date (YYYY-MM-DD)`,
    );
  }
  return date;
}

// Los montos son Decimal(14,2): sumar en centavos enteros es exacto (14 dígitos
// caben de sobra en un entero seguro de JS) y evita que 0.1 + 0.2 salga
// 0.30000000000000004 en un total de caja.
function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function methodRank(method: PaymentMethod | null): number {
  return METHOD_ORDER.indexOf(method);
}

function summarize(groups: CashRegisterGroup[]): CashPaymentsSummary {
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

  const byMethod = groups
    .map((group) => ({
      method: group.method,
      currency: group.currency,
      total: toCents(group.total) / 100,
      count: group.count,
    }))
    .sort(
      (a, b) =>
        methodRank(a.method) - methodRank(b.method) ||
        a.currency.localeCompare(b.currency),
    );

  return { count, byCurrency, byMethod };
}

/**
 * La CAJA de la clínica: todos los abonos de un período, de la sede activa (o
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
  ) {}

  /**
   * `actor` (del token) solo decide `canVoid` de cada fila: qué abonos puede
   * anular quien consulta, con la misma regla que aplica la anulación.
   */
  async execute(
    input: ListCashPaymentsInput,
    actor: VoidActor,
  ): Promise<ListCashPaymentsOutput> {
    const from = parseCivilDate(input.from, 'from');
    const to = parseCivilDate(input.to, 'to');
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('from must be on or before to');
    }
    const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
    if (days > MAX_RANGE_DAYS) {
      throw new BadRequestException(
        `the period cannot exceed ${MAX_RANGE_DAYS} days`,
      );
    }

    const page = normalizePage(input.page);
    const pageSize = normalizePageSize(input.pageSize);

    const result = await this.repo.listForCashRegister({
      from,
      toExclusive: new Date(to.getTime() + DAY_MS),
      method: input.method,
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const now = this.now();
    return {
      items: result.items.map(({ payment, voidSubject }) => ({
        ...payment,
        canVoid: canVoidPayment(voidSubject, actor, now),
      })),
      total: result.total,
      page,
      pageSize,
      from: input.from,
      to: input.to,
      scope: { location: result.scopeLocation },
      summary: summarize(result.groups),
    };
  }
}
