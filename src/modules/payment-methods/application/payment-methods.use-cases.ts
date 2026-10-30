import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PaymentMethodKind } from '@prisma/client';
import type { ClinicPaymentMethodEntity } from '../domain/payment-method.entity';
import {
  PAYMENT_METHOD_REPOSITORY,
  type PaymentMethodRepository,
  type PaymentMethodWriteInput,
} from '../domain/ports/payment-method-repository.port';
import {
  DUPLICATE_PAYMENT_METHOD_NAME_MESSAGE,
  INITIAL_KIND_LOCKED_MESSAGE,
  PAYMENT_METHOD_NOT_FOUND_MESSAGE,
  paymentMethodNameError,
} from '../domain/payment-method-rules';

export interface PaymentMethodInput {
  name: string;
  kind: PaymentMethodKind;
  active?: boolean;
  requiresReference?: boolean;
}

function normalizedName(name: string): string {
  const error = paymentMethodNameError(name);
  if (error !== null) throw new BadRequestException(error);
  return name.trim();
}

@Injectable()
export class ListPaymentMethodsUseCase {
  constructor(
    @Inject(PAYMENT_METHOD_REPOSITORY)
    private readonly repo: PaymentMethodRepository,
  ) {}

  /** Por defecto solo los activos (el selector del modal de abono). */
  execute(params: {
    includeInactive?: boolean;
  }): Promise<ClinicPaymentMethodEntity[]> {
    return this.repo.list({ includeInactive: params.includeInactive === true });
  }
}

@Injectable()
export class CreatePaymentMethodUseCase {
  constructor(
    @Inject(PAYMENT_METHOD_REPOSITORY)
    private readonly repo: PaymentMethodRepository,
  ) {}

  async execute(
    input: PaymentMethodInput,
    userId: string,
  ): Promise<ClinicPaymentMethodEntity> {
    const name = normalizedName(input.name);
    if (await this.repo.nameTaken(name)) {
      throw new ConflictException(DUPLICATE_PAYMENT_METHOD_NAME_MESSAGE);
    }
    return this.repo.create(
      {
        name,
        kind: input.kind,
        active: input.active ?? true,
        requiresReference: input.requiresReference ?? false,
      },
      userId,
    );
  }
}

@Injectable()
export class UpdatePaymentMethodUseCase {
  constructor(
    @Inject(PAYMENT_METHOD_REPOSITORY)
    private readonly repo: PaymentMethodRepository,
  ) {}

  async execute(
    id: string,
    input: Partial<PaymentMethodInput>,
    userId: string,
  ): Promise<ClinicPaymentMethodEntity> {
    if (input.kind !== undefined) {
      const current = await this.repo.findById(id);
      if (!current) {
        throw new NotFoundException(PAYMENT_METHOD_NOT_FOUND_MESSAGE);
      }
      // Un medio inicial conserva su tipo base (ver INITIAL_KIND_LOCKED_MESSAGE).
      if (current.legacyMethod !== null && current.kind !== input.kind) {
        throw new BadRequestException(INITIAL_KIND_LOCKED_MESSAGE);
      }
    }
    const data: PaymentMethodWriteInput = {
      kind: input.kind,
      active: input.active,
      requiresReference: input.requiresReference,
    };
    if (input.name !== undefined) {
      data.name = normalizedName(input.name);
      if (await this.repo.nameTaken(data.name, id)) {
        throw new ConflictException(DUPLICATE_PAYMENT_METHOD_NAME_MESSAGE);
      }
    }
    const updated = await this.repo.update(id, data, userId);
    if (!updated) throw new NotFoundException(PAYMENT_METHOD_NOT_FOUND_MESSAGE);
    return updated;
  }
}
