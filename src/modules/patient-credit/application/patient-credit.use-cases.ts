import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ClinicRole, PaymentMethod } from '@prisma/client';
import {
  CREDIT_AMOUNT_EXCEEDS_MESSAGE,
  CREDIT_CURRENCY_MISMATCH_MESSAGE,
  CREDIT_IDEMPOTENCY_INVALID_MESSAGE,
  CREDIT_IDEMPOTENCY_REUSED_MESSAGE,
  CREDIT_MAX_REFERENCE_PAYMENTS,
  CREDIT_PAYMENTS_REQUIRED_MESSAGE,
  CREDIT_PLAN_NOT_FOUND_MESSAGE,
  CREDIT_REASON_REQUIRED_MESSAGE,
  CREDIT_REFUND_NOT_FOUND_MESSAGE,
  CREDIT_SAME_PLAN_MESSAGE,
  CREDIT_TARGET_CURRENCY_MESSAGE,
  CREDIT_TARGET_NOT_BILLABLE_MESSAGE,
  CREDIT_TARGET_OTHER_PATIENT_MESSAGE,
  canMoveCredit,
  fromCents,
  normalizeReason,
  parseIdempotencyKey,
  receptionCapMessage,
  refundFingerprint,
  toCents,
  transferFingerprint,
} from '../domain/patient-credit';
import {
  PATIENT_CREDIT_REPOSITORY,
  type CreditRefundRecord,
  type CreditTransferRecord,
  type PatientCreditMovements,
  type PatientCreditRepository,
  type PlanCreditState,
} from '../domain/ports/patient-credit-repository.port';
import { isPlanBillable } from '../../treatment-plans/domain/plan-status-machine';

/** Quién actúa, del token (nunca del cuerpo). */
export interface CreditActor {
  userId: string;
  role: ClinicRole;
}

export interface TransferCreditInput {
  targetPlanId: string;
  amount: number;
  currency: string;
  reason?: string | null;
}

export interface RefundCreditInput {
  amount: number;
  currency: string;
  method: PaymentMethod;
  reason: string;
  paymentIds: string[];
}

export interface TransferResult extends CreditTransferRecord {
  /** Saldo a favor que le queda al origen tras el traspaso. */
  sourceCreditAfter: number;
}

async function loadPlan(
  repo: PatientCreditRepository,
  planId: string,
): Promise<PlanCreditState> {
  const plan = await repo.readPlanCredit(planId);
  if (!plan) throw new NotFoundException(CREDIT_PLAN_NOT_FOUND_MESSAGE);
  return plan;
}

/**
 * Moneda, tope del rol e importe contra el saldo a favor del origen (lectura
 * sin bloqueo: el repositorio lo vuelve a comprobar dentro del bloqueo y da
 * 409 si otro movimiento se adelantó). Devuelve el importe en céntimos.
 */
async function checkAmount(
  repo: PatientCreditRepository,
  source: PlanCreditState,
  amount: number,
  currency: string,
  actor: CreditActor,
): Promise<number> {
  if (currency.trim().toUpperCase() !== source.currency) {
    throw new BadRequestException(CREDIT_CURRENCY_MISMATCH_MESSAGE);
  }
  const amountCents = toCents(amount);
  const cap = await repo.receptionCapCents();
  if (!canMoveCredit(actor.role, amountCents, cap)) {
    throw new ForbiddenException(receptionCapMessage(cap));
  }
  if (amountCents > source.creditCents) {
    throw new BadRequestException(CREDIT_AMOUNT_EXCEEDS_MESSAGE);
  }
  return amountCents;
}

function keyOf(raw: string | undefined): string | undefined {
  const key = parseIdempotencyKey(raw);
  if (key === null) {
    throw new BadRequestException(CREDIT_IDEMPOTENCY_INVALID_MESSAGE);
  }
  return key;
}

/**
 * Traspaso de saldo a favor a otro plan vivo del MISMO paciente (DX-253). El
 * grupo familiar (DX-203) queda fuera de esta porción: el traspaso solo se
 * ofrece y se admite entre planes del mismo paciente (FK compuesta en BD).
 */
@Injectable()
export class TransferCreditUseCase {
  constructor(
    @Inject(PATIENT_CREDIT_REPOSITORY)
    private readonly repo: PatientCreditRepository,
  ) {}

  async execute(
    sourcePlanId: string,
    input: TransferCreditInput,
    actor: CreditActor,
    rawKey?: string,
  ): Promise<TransferResult> {
    const key = keyOf(rawKey);
    // El motivo del traspaso es opcional; si llega, con la misma regla.
    const typed = input.reason?.trim() ? input.reason : null;
    const reason = typed === null ? null : normalizeReason(typed);
    if (typed !== null && reason === null) {
      throw new BadRequestException(CREDIT_REASON_REQUIRED_MESSAGE);
    }
    const currency = input.currency.trim().toUpperCase();
    const fingerprint = transferFingerprint({
      sourcePlanId,
      targetPlanId: input.targetPlanId,
      amountCents: toCents(input.amount),
      currency,
      reason,
    });
    if (key) {
      const existing = await this.repo.findTransferByKey(key);
      if (existing) return this.replay(existing, fingerprint);
    }
    if (sourcePlanId.toLowerCase() === input.targetPlanId.toLowerCase()) {
      throw new BadRequestException(CREDIT_SAME_PLAN_MESSAGE);
    }
    const source = await loadPlan(this.repo, sourcePlanId);
    const target = await loadPlan(this.repo, input.targetPlanId);
    if (target.patientId !== source.patientId) {
      throw new BadRequestException(CREDIT_TARGET_OTHER_PATIENT_MESSAGE);
    }
    if (target.currency !== source.currency) {
      throw new BadRequestException(CREDIT_TARGET_CURRENCY_MESSAGE);
    }
    if (!isPlanBillable(target.status)) {
      throw new ConflictException(CREDIT_TARGET_NOT_BILLABLE_MESSAGE);
    }
    const amountCents = await checkAmount(
      this.repo,
      source,
      input.amount,
      currency,
      actor,
    );
    const transfer = await this.repo.createTransfer({
      sourcePlanId: source.planId,
      targetPlanId: target.planId,
      amountCents,
      currency: source.currency,
      reason,
      userId: actor.userId,
      idempotencyKey: key,
      fingerprint,
    });
    return this.withCredit(transfer);
  }

  private async replay(
    existing: CreditTransferRecord,
    fingerprint: string,
  ): Promise<TransferResult> {
    if (existing.idempotencyFingerprint !== fingerprint) {
      throw new UnprocessableEntityException(CREDIT_IDEMPOTENCY_REUSED_MESSAGE);
    }
    return this.withCredit(existing);
  }

  private async withCredit(
    transfer: CreditTransferRecord,
  ): Promise<TransferResult> {
    const source = await this.repo.readPlanCredit(transfer.sourcePlanId);
    return {
      ...transfer,
      sourceCreditAfter: fromCents(source?.creditCents ?? 0),
    };
  }
}

/**
 * Devolución del saldo a favor al paciente (DX-253): no anula ni toca los
 * abonos (la traza contable queda completa); en efectivo es un egreso de la
 * caja abierta de quien devuelve en su sede.
 */
@Injectable()
export class RefundCreditUseCase {
  constructor(
    @Inject(PATIENT_CREDIT_REPOSITORY)
    private readonly repo: PatientCreditRepository,
  ) {}

  async execute(
    planId: string,
    input: RefundCreditInput,
    actor: CreditActor,
    rawKey?: string,
  ): Promise<CreditRefundRecord> {
    const key = keyOf(rawKey);
    const reason = normalizeReason(input.reason);
    if (reason === null) {
      throw new BadRequestException(CREDIT_REASON_REQUIRED_MESSAGE);
    }
    const paymentIds = [...new Set(input.paymentIds ?? [])];
    if (
      paymentIds.length === 0 ||
      paymentIds.length > CREDIT_MAX_REFERENCE_PAYMENTS
    ) {
      throw new BadRequestException(CREDIT_PAYMENTS_REQUIRED_MESSAGE);
    }
    const currency = input.currency.trim().toUpperCase();
    const fingerprint = refundFingerprint({
      planId,
      amountCents: toCents(input.amount),
      currency,
      method: input.method,
      reason,
      paymentIds,
    });
    if (key) {
      const existing = await this.repo.findRefundByKey(key);
      if (existing) {
        if (existing.idempotencyFingerprint !== fingerprint) {
          throw new UnprocessableEntityException(
            CREDIT_IDEMPOTENCY_REUSED_MESSAGE,
          );
        }
        return existing;
      }
    }
    const source = await loadPlan(this.repo, planId);
    const amountCents = await checkAmount(
      this.repo,
      source,
      input.amount,
      currency,
      actor,
    );
    return this.repo.createRefund({
      planId: source.planId,
      amountCents,
      currency: source.currency,
      method: input.method,
      reason,
      paymentIds,
      userId: actor.userId,
      idempotencyKey: key,
      fingerprint,
    });
  }
}

@Injectable()
export class GetCreditRefundUseCase {
  constructor(
    @Inject(PATIENT_CREDIT_REPOSITORY)
    private readonly repo: PatientCreditRepository,
  ) {}

  async execute(id: string): Promise<CreditRefundRecord> {
    const refund = await this.repo.getRefund(id);
    if (!refund) throw new NotFoundException(CREDIT_REFUND_NOT_FOUND_MESSAGE);
    return refund;
  }
}

@Injectable()
export class ListPatientCreditUseCase {
  constructor(
    @Inject(PATIENT_CREDIT_REPOSITORY)
    private readonly repo: PatientCreditRepository,
  ) {}

  async execute(patientId: string): Promise<PatientCreditMovements> {
    const movements = await this.repo.listByPatient(patientId);
    if (!movements) throw new NotFoundException('Paciente no encontrado.');
    return movements;
  }
}

export interface CreditPolicyView {
  /** Tope de RECEPTION por operación (0 = no puede). ADMIN no tiene tope. */
  receptionMaxAmount: number;
}

@Injectable()
export class CreditPolicyUseCases {
  constructor(
    @Inject(PATIENT_CREDIT_REPOSITORY)
    private readonly repo: PatientCreditRepository,
  ) {}

  async get(): Promise<CreditPolicyView> {
    return {
      receptionMaxAmount: fromCents(await this.repo.receptionCapCents()),
    };
  }

  async update(receptionMaxAmount: number): Promise<CreditPolicyView> {
    const cents = await this.repo.updateReceptionCap(
      toCents(receptionMaxAmount),
    );
    return { receptionMaxAmount: fromCents(cents) };
  }
}
