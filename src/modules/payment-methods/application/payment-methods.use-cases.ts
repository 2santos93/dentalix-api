import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  PaymentAdjustmentCalculation,
  PaymentAdjustmentType,
  PaymentMethodKind,
} from '@prisma/client';
import type {
  ClinicPaymentMethodEntity,
  PaymentMethodAdjustmentEntity,
} from '../domain/payment-method.entity';
import {
  PAYMENT_METHOD_REPOSITORY,
  type PaymentAdjustmentWriteInput,
  type PaymentAdjustmentWriteResult,
  type PaymentMethodRepository,
  type PaymentMethodWriteInput,
} from '../domain/ports/payment-method-repository.port';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  CURRENCY_DIGITS_CATALOG,
  type CurrencyDigitsCatalog,
} from '../../../shared/money/currency-digits';
import {
  ADJUSTMENT_FIXED_MESSAGE,
  ADJUSTMENT_LABEL_TAKEN_MESSAGE,
  ADJUSTMENT_NOT_FOUND_MESSAGE,
  ADJUSTMENT_PERCENT_MESSAGE,
  ADJUSTMENT_SHAPE_MESSAGE,
  ADJUSTMENTS_LIMIT_MESSAGE,
  adjustmentFixedDigitsMessage,
  adjustmentLabelError,
  fitsCurrencyDigits,
  isValidAdjustmentPercent,
} from '../domain/payment-adjustments';
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

/** DX-516: lo que llega del cliente para un ajuste (alta: todo; cambio: parte). */
export interface PaymentAdjustmentInput {
  type: PaymentAdjustmentType;
  label: string;
  calculation: PaymentAdjustmentCalculation;
  percent?: number | null;
  fixedAmount?: number | null;
  fixedCurrency?: string | null;
  active?: boolean;
}

/**
 * DX-516: valida la forma completa de un ajuste (etiqueta, porcentaje o
 * importe fijo con su moneda del catálogo y sus decimales de redondeo).
 */
async function validAdjustment(
  input: PaymentAdjustmentInput,
  digits: CurrencyDigitsCatalog,
): Promise<PaymentAdjustmentWriteInput> {
  const labelError = adjustmentLabelError(input.label);
  if (labelError !== null) throw new BadRequestException(labelError);
  const label = input.label.trim();
  const active = input.active ?? true;
  if (input.calculation === 'PERCENT') {
    if (
      (input.fixedAmount ?? null) !== null ||
      (input.fixedCurrency ?? null) !== null
    ) {
      throw new BadRequestException(ADJUSTMENT_SHAPE_MESSAGE);
    }
    if (!isValidAdjustmentPercent(input.percent)) {
      throw new BadRequestException(ADJUSTMENT_PERCENT_MESSAGE);
    }
    return {
      type: input.type,
      label,
      calculation: 'PERCENT',
      percent: input.percent,
      fixedAmount: null,
      fixedCurrency: null,
      active,
    };
  }
  if ((input.percent ?? null) !== null) {
    throw new BadRequestException(ADJUSTMENT_SHAPE_MESSAGE);
  }
  const amount = input.fixedAmount;
  const currency = input.fixedCurrency?.trim().toUpperCase() ?? '';
  if (
    typeof amount !== 'number' ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    currency === ''
  ) {
    throw new BadRequestException(ADJUSTMENT_FIXED_MESSAGE);
  }
  const table = await digits.table([currency]);
  if (!table.has(currency)) {
    throw new BadRequestException(`Moneda desconocida: ${currency}`);
  }
  const rounding = table.roundingDigits(currency);
  if (!fitsCurrencyDigits(amount, rounding)) {
    throw new BadRequestException(
      adjustmentFixedDigitsMessage(currency, rounding),
    );
  }
  return {
    type: input.type,
    label,
    calculation: 'FIXED',
    percent: null,
    fixedAmount: amount,
    fixedCurrency: currency,
    active,
  };
}

function adjustmentResult(result: PaymentAdjustmentWriteResult) {
  if (result.ok) return result.adjustment;
  switch (result.reason) {
    case 'METHOD_NOT_FOUND':
      throw new NotFoundException(PAYMENT_METHOD_NOT_FOUND_MESSAGE);
    case 'NOT_FOUND':
      throw new NotFoundException(ADJUSTMENT_NOT_FOUND_MESSAGE);
    case 'LABEL_TAKEN':
      throw new ConflictException(ADJUSTMENT_LABEL_TAKEN_MESSAGE);
    case 'LIMIT':
      throw new ConflictException(ADJUSTMENTS_LIMIT_MESSAGE);
  }
}

/** DX-516: alta de un ajuste en un medio (solo ADMIN; auditado en el repositorio). */
@Injectable()
export class CreatePaymentAdjustmentUseCase {
  constructor(
    @Inject(PAYMENT_METHOD_REPOSITORY)
    private readonly repo: PaymentMethodRepository,
    @Inject(CURRENCY_DIGITS_CATALOG)
    private readonly digits: CurrencyDigitsCatalog,
  ) {}

  async execute(
    paymentMethodId: string,
    input: PaymentAdjustmentInput,
    audit: AuditRequestContext,
  ): Promise<PaymentMethodAdjustmentEntity> {
    const data = await validAdjustment(input, this.digits);
    return adjustmentResult(
      await this.repo.createAdjustment(paymentMethodId, data, audit),
    );
  }
}

/**
 * DX-516: cambio de un ajuste (también desactivarlo). Lo que no llega se
 * conserva; la forma resultante se valida entera. Cambiar el cálculo de
 * porcentaje a fijo (o al revés) limpia el otro campo.
 */
@Injectable()
export class UpdatePaymentAdjustmentUseCase {
  constructor(
    @Inject(PAYMENT_METHOD_REPOSITORY)
    private readonly repo: PaymentMethodRepository,
    @Inject(CURRENCY_DIGITS_CATALOG)
    private readonly digits: CurrencyDigitsCatalog,
  ) {}

  async execute(
    paymentMethodId: string,
    adjustmentId: string,
    input: Partial<PaymentAdjustmentInput>,
    audit: AuditRequestContext,
  ): Promise<PaymentMethodAdjustmentEntity> {
    const method = await this.repo.findById(paymentMethodId);
    if (!method) throw new NotFoundException(PAYMENT_METHOD_NOT_FOUND_MESSAGE);
    const current = method.adjustments.find((a) => a.id === adjustmentId);
    if (!current) throw new NotFoundException(ADJUSTMENT_NOT_FOUND_MESSAGE);
    const calculation = input.calculation ?? current.calculation;
    const switched = calculation !== current.calculation;
    const merged: PaymentAdjustmentInput = {
      type: input.type ?? current.type,
      label: input.label ?? current.label,
      calculation,
      percent:
        input.percent !== undefined
          ? input.percent
          : switched
            ? null
            : current.percent,
      fixedAmount:
        input.fixedAmount !== undefined
          ? input.fixedAmount
          : switched
            ? null
            : current.fixedAmount,
      fixedCurrency:
        input.fixedCurrency !== undefined
          ? input.fixedCurrency
          : switched
            ? null
            : current.fixedCurrency,
      active: input.active ?? current.active,
    };
    const data = await validAdjustment(merged, this.digits);
    return adjustmentResult(
      await this.repo.updateAdjustment(
        paymentMethodId,
        adjustmentId,
        data,
        audit,
      ),
    );
  }
}
