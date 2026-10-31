import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
import type {
  PaymentRepository,
  PaymentVoidRequest,
  PaymentVoidTarget,
} from '../../domain/ports/payment-repository.port';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { voidDenial, type VoidActor } from '../../domain/void-window';

export type PaymentClock = () => Date;
export const PAYMENT_CLOCK = Symbol('PAYMENT_CLOCK');

export interface VoidPaymentInput {
  paymentId: string;
  /** Motivo ya validado (3–300 caracteres, sin espacios en los extremos). */
  reason: string;
  /** Quién anula: del token, nunca del cuerpo. */
  actor: VoidActor;
  /**
   * Desde dónde (sede activa, request id, IP, user agent): lo lleva el
   * `audit_event` del compromiso de pago que se reabre (DX-215).
   */
  request?: PaymentVoidRequest;
}

@Injectable()
export class VoidPaymentUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY)
    private readonly repo: PaymentRepository,
    @Inject(PAYMENT_CLOCK)
    private readonly now: PaymentClock,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Devuelve los ids de las OTRAS líneas que se anularon con él (DX-390: un
   * cobro dividido se anula entero); `[]` en un abono suelto.
   */
  async execute(input: VoidPaymentInput): Promise<string[]> {
    const target = await this.repo.findVoidTarget(input.paymentId);
    if (!target) {
      throw new NotFoundException('Payment not found');
    }

    this.tenantContext.assertLocationAllowed(target.locationId);

    const now = this.now();
    // DX-390: todas las líneas de un cobro dividido las registró la misma
    // persona en la misma petición; la regla se mira en la pedida.
    this.assertActorMayVoid(target, input.actor, now);

    // Soft-delete only — never a hard delete on a domain table. A voided
    // payment is a financial record too: it must remain queryable for
    // audit, just excluded from active lists/balances/totals via
    // `deletedAt: null`.
    //
    // The write is a single atomic check-and-set (`deletedAt IS NULL`), so two
    // concurrent voids of the same payment can't both win (TOCTOU race): the
    // loser gets `false` -> 404, same as a nonexistent payment. The read above
    // only feeds the permission rule, and what it reads (author, creation
    // time, sede) never changes after the payment is recorded.
    //
    // DX-215: the same transaction re-opens the payment promise this payment
    // had kept, if it no longer is (see `softDelete`).
    const voided = await this.repo.softDelete(input.paymentId, {
      voidedById: input.actor.userId,
      voidedByRole: input.actor.role,
      voidedAt: now,
      reason: input.reason,
      request: input.request ?? null,
    });
    if (!voided) {
      throw new NotFoundException('Payment not found');
    }
    return target.splitPaymentIds.filter((id) => id !== input.paymentId);
  }

  /** La regla vive en `voidDenial` (dominio); aquí solo se traduce a 403. */
  private assertActorMayVoid(
    target: PaymentVoidTarget,
    actor: VoidPaymentInput['actor'],
    now: Date,
  ): void {
    const denial = voidDenial(target, actor, now);
    if (denial === 'NOT_AUTHOR') {
      throw new ForbiddenException(
        'Solo puedes anular abonos que registraste tú. Pide a un administrador que lo anule.',
      );
    }
    if (denial === 'NOT_SAME_DAY') {
      throw new ForbiddenException(
        'Solo puedes anular abonos registrados hoy. Pide a un administrador que lo anule.',
      );
    }
  }
}
