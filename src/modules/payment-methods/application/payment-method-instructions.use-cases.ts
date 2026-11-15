import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  PAYMENT_INSTRUCTIONS_LOCATION_NOT_FOUND_MESSAGE,
  PAYMENT_INSTRUCTIONS_NOT_FOUND_MESSAGE,
  parsePaymentInstructions,
  type PaymentInstructionField,
  type PaymentMethodInstruction,
} from '../domain/payment-method-instructions';
import { PAYMENT_METHOD_NOT_FOUND_MESSAGE } from '../domain/payment-method-rules';
import {
  PAYMENT_METHOD_INSTRUCTION_REPOSITORY,
  type PaymentMethodInstructionRepository,
} from '../domain/ports/payment-method-instruction-repository.port';

/** DX-569: los datos para pagar de un medio (la clínica y cada sede). */
@Injectable()
export class ListPaymentMethodInstructionsUseCase {
  constructor(
    @Inject(PAYMENT_METHOD_INSTRUCTION_REPOSITORY)
    private readonly repo: PaymentMethodInstructionRepository,
  ) {}

  async execute(paymentMethodId: string): Promise<PaymentMethodInstruction[]> {
    const rows = await this.repo.listByMethod(paymentMethodId);
    if (!rows) throw new NotFoundException(PAYMENT_METHOD_NOT_FOUND_MESSAGE);
    return rows;
  }
}

export type PaymentInstructionsInput = Partial<
  Record<PaymentInstructionField, string | null>
> & { locationId?: string | null };

/**
 * DX-569: guarda los datos para pagar de un medio en una sede (o de toda la
 * clínica, sin sede). Al menos un campo con texto. Los de una sede solo los
 * escribe quien tiene acceso a ella (403 `LOCATION_NOT_ALLOWED`).
 */
@Injectable()
export class SavePaymentMethodInstructionsUseCase {
  constructor(
    @Inject(PAYMENT_METHOD_INSTRUCTION_REPOSITORY)
    private readonly repo: PaymentMethodInstructionRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(
    paymentMethodId: string,
    input: PaymentInstructionsInput,
    audit: AuditRequestContext,
  ): Promise<PaymentMethodInstruction> {
    const parsed = parsePaymentInstructions(input);
    if (!parsed.ok) throw new BadRequestException(parsed.message);
    const locationId = input.locationId ?? null;
    if (locationId !== null) {
      this.tenantContext.assertLocationAllowed(locationId);
    }
    const result = await this.repo.upsert(
      paymentMethodId,
      locationId,
      parsed.fields,
      audit,
    );
    if (result.ok) return result.instruction;
    throw result.reason === 'METHOD_NOT_FOUND'
      ? new NotFoundException(PAYMENT_METHOD_NOT_FOUND_MESSAGE)
      : new BadRequestException(
          PAYMENT_INSTRUCTIONS_LOCATION_NOT_FOUND_MESSAGE,
        );
  }
}

/**
 * DX-569: quita los datos para pagar de una sede (vuelven a regir los de la
 * clínica) o los de la clínica. Los de una sede, solo con acceso a ella.
 */
@Injectable()
export class RemovePaymentMethodInstructionsUseCase {
  constructor(
    @Inject(PAYMENT_METHOD_INSTRUCTION_REPOSITORY)
    private readonly repo: PaymentMethodInstructionRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(
    paymentMethodId: string,
    instructionId: string,
    audit: AuditRequestContext,
  ): Promise<void> {
    const rows = await this.repo.listByMethod(paymentMethodId);
    const current = rows?.find((r) => r.id === instructionId);
    if (!current) {
      throw new NotFoundException(PAYMENT_INSTRUCTIONS_NOT_FOUND_MESSAGE);
    }
    this.tenantContext.assertRecordLocationAllowed(current.locationId);
    const removed = await this.repo.remove(
      paymentMethodId,
      instructionId,
      audit,
    );
    if (!removed) {
      throw new NotFoundException(PAYMENT_INSTRUCTIONS_NOT_FOUND_MESSAGE);
    }
  }
}
