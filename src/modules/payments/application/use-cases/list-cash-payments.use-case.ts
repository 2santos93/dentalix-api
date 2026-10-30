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
  /** DX-377: total por medio de pago de la clínica y moneda. */
  byPaymentMethod: CashPaymentMethodTotal[];
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

  return { count, byCurrency, byMethod, byPaymentMethod };
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
  ) {}

  /**
   * `actor` (del token) solo decide `canVoid` de cada fila: qué abonos puede
   * anular quien consulta, con la misma regla que aplica la anulación.
   */
  async execute(
    input: ListCashPaymentsInput,
    actor: VoidActor,
  ): Promise<ListCashPaymentsOutput> {
    // Días que existan (`2026-02-30` no), en el rango admitido y en orden. El
    // período se queda en días civiles: cada sede lo traduce a instantes en
    // SU zona (DX-097), en el repositorio.
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
    const { from, to } = period;

    const page = normalizePage(input.page);
    const pageSize = normalizePageSize(input.pageSize);

    const result = await this.repo.listForCashRegister({
      from,
      to,
      method: input.method,
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const now = this.now();
    return {
      items: result.items.map(({ payment, voidSubject }) => {
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
      }),
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
