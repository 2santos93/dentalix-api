import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  cashOutflowFingerprint,
  parseIdempotencyKey,
} from '../../domain/expense-idempotency';
import {
  CASH_SESSION_IN_SEVERAL_LOCATIONS_MESSAGE,
  IDEMPOTENCY_KEY_INVALID_MESSAGE,
  OPEN_CASH_SESSION_REQUIRED_MESSAGE,
} from '../../domain/expense-rules';
import {
  EXPENSE_CASH_LINK,
  type ExpenseCashLink,
} from '../../domain/ports/expense-cash-link.port';
import {
  EXPENSE_REPOSITORY,
  type ExpenseRepository,
} from '../../domain/ports/expense-repository.port';
import { EXPENSE_CLOCK, type ExpenseClock } from '../expense-tokens';
import { type ExpenseDetailView, detailViewOf } from '../expense-view';
import { guarded } from '../guarded';
import {
  type IdempotencySignals,
  assertSameRequest,
} from '../idempotency-guard';
import { CreateExpenseUseCase } from './create-expense.use-case';

export interface CashOutflowInput {
  category: string;
  supplier?: string | null;
  description?: string | null;
  amount: number;
  currency: string;
  attachmentUploadId?: string;
}

/**
 * Salida de caja menor (DX-274, R1/R8): recepción (o ADMIN) paga algo con el
 * dinero del cajón. Es un gasto de la sede de SU caja abierta, con fecha de
 * hoy, pagado en el acto desde esa caja: el mismo alta que `POST /expenses`
 * con `payment.fromCashSession` (una transacción, mismas reglas, mismo
 * soporte), sin repetir nada. La respuesta es el gasto: nunca el esperado de
 * la caja (arqueo ciego, R6).
 */
@Injectable()
export class CreateCashOutflowUseCase {
  constructor(
    private readonly createExpense: CreateExpenseUseCase,
    @Inject(EXPENSE_REPOSITORY) private readonly repo: ExpenseRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(EXPENSE_CLOCK) private readonly clock: ExpenseClock,
    @Optional()
    @Inject(EXPENSE_CASH_LINK)
    private readonly cashLink?: ExpenseCashLink,
  ) {}

  /**
   * Orden: clave de idempotencia (una repetición devuelve la original aunque
   * la caja ya esté cerrada) → caja abierta de quien la registra → alta. La
   * caja se vuelve a tomar con `FOR SHARE` dentro de la transacción del pago:
   * si se cierra entre medias, es un 409 y no queda nada.
   */
  async execute(
    input: CashOutflowInput,
    createdById: string,
    idempotencyHeader?: string,
    signals?: IdempotencySignals,
  ): Promise<ExpenseDetailView> {
    const key = parseIdempotencyKey(idempotencyHeader);
    if (key === null) {
      throw new BadRequestException(IDEMPOTENCY_KEY_INVALID_MESSAGE);
    }
    const fingerprint = key ? cashOutflowFingerprint(input) : undefined;
    if (key) {
      const existing = await guarded(() =>
        this.repo.findByIdempotencyKey(key, this.clock()),
      );
      if (existing) {
        assertSameRequest(existing.fingerprint, fingerprint);
        if (signals) signals.replayed = true;
        return detailViewOf(this.repo, existing.detail);
      }
    }

    if (!this.cashLink) {
      // Error de montaje: ExpensesModule importa CashSessionsModule.
      throw new Error('Salida de caja sin ExpenseCashLink');
    }
    // Con X-Location-Id, solo la caja de esa sede; sin ella, la de cualquier
    // sede permitida, si es una sola.
    const locations = await this.cashLink.openSessionLocations(
      createdById,
      this.tenantContext.scopeLocationIds(),
    );
    if (locations.length === 0) {
      throw new ConflictException(OPEN_CASH_SESSION_REQUIRED_MESSAGE);
    }
    if (locations.length > 1) {
      throw new ConflictException(CASH_SESSION_IN_SEVERAL_LOCATIONS_MESSAGE);
    }
    const locationId = locations[0];
    const today = await this.repo.locationToday(locationId, this.clock());
    return this.createExpense.createIdempotent(
      {
        locationId,
        category: input.category,
        supplier: input.supplier,
        description: input.description,
        amount: input.amount,
        currency: input.currency,
        invoiceDate: today,
        payment: {
          amount: input.amount,
          method: 'CASH',
          fromCashSession: true,
        },
        attachmentUploadId: input.attachmentUploadId,
      },
      createdById,
      key,
      fingerprint,
      signals,
    );
  }
}
