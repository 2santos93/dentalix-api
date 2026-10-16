import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
import type {
  PaymentRepository,
  PaymentVoidTarget,
} from '../../domain/ports/payment-repository.port';
import { isSameCivilDay } from '../../domain/void-window';

export type PaymentClock = () => Date;
export const PAYMENT_CLOCK = Symbol('PAYMENT_CLOCK');

export interface VoidPaymentInput {
  paymentId: string;
  /** Motivo ya validado (3–300 caracteres, sin espacios en los extremos). */
  reason: string;
  /** Quién anula: del token, nunca del cuerpo. */
  actor: { userId: string; role: ClinicRole };
}

@Injectable()
export class VoidPaymentUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY)
    private readonly repo: PaymentRepository,
    @Inject(PAYMENT_CLOCK)
    private readonly now: PaymentClock,
  ) {}

  async execute(input: VoidPaymentInput): Promise<void> {
    const target = await this.repo.findVoidTarget(input.paymentId);
    if (!target) {
      throw new NotFoundException('Payment not found');
    }

    const now = this.now();
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
    const voided = await this.repo.softDelete(input.paymentId, {
      voidedById: input.actor.userId,
      voidedAt: now,
      reason: input.reason,
    });
    if (!voided) {
      throw new NotFoundException('Payment not found');
    }
  }

  /**
   * SEC-013: ADMIN anula cualquier abono. Cualquier otro rol con acceso a
   * pagos (hoy solo RECEPTION) únicamente los que registró ÉL MISMO y en el
   * MISMO día de la sede — corregir un error de mostrador, no deshacer la caja
   * de otro ni la de días ya cerrados. Un abono sin autor (legado) es solo de
   * ADMIN.
   */
  private assertActorMayVoid(
    target: PaymentVoidTarget,
    actor: VoidPaymentInput['actor'],
    now: Date,
  ): void {
    if (actor.role === ClinicRole.ADMIN) {
      return;
    }
    if (target.createdById !== actor.userId) {
      throw new ForbiddenException(
        'Solo puedes anular abonos que registraste tú. Pide a un administrador que lo anule.',
      );
    }
    if (!isSameCivilDay(target.createdAt, now, target.timeZone)) {
      throw new ForbiddenException(
        'Solo puedes anular abonos registrados hoy. Pide a un administrador que lo anule.',
      );
    }
  }
}
