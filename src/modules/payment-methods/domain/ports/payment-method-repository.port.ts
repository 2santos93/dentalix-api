import type {
  PaymentAdjustmentCalculation,
  PaymentAdjustmentType,
  PaymentMethod,
  PaymentMethodKind,
} from '@prisma/client';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type {
  ClinicPaymentMethodEntity,
  PaymentMethodAdjustmentEntity,
} from '../payment-method.entity';

export const PAYMENT_METHOD_REPOSITORY = Symbol('PAYMENT_METHOD_REPOSITORY');

export interface PaymentMethodWriteInput {
  name?: string;
  kind?: PaymentMethodKind;
  active?: boolean;
  requiresReference?: boolean;
}

/** DX-516: un ajuste ya validado por el caso de uso (la forma completa). */
export interface PaymentAdjustmentWriteInput {
  type: PaymentAdjustmentType;
  label: string;
  calculation: PaymentAdjustmentCalculation;
  percent: number | null;
  fixedAmount: number | null;
  fixedCurrency: string | null;
  active: boolean;
}

/** Resultado de escribir un ajuste (el repositorio decide con la fila bloqueada). */
export type PaymentAdjustmentWriteResult =
  | { ok: true; adjustment: PaymentMethodAdjustmentEntity }
  | {
      ok: false;
      reason: 'METHOD_NOT_FOUND' | 'NOT_FOUND' | 'LABEL_TAKEN' | 'LIMIT';
    };

/** Catálogo de medios de pago de la clínica del contexto (bajo RLS). */
export interface PaymentMethodRepository {
  list(params: {
    includeInactive: boolean;
  }): Promise<ClinicPaymentMethodEntity[]>;
  findById(id: string): Promise<ClinicPaymentMethodEntity | null>;
  /** El medio inicial equivalente a un método antiguo (cliente o réplica viejos). */
  findByLegacyMethod(
    method: PaymentMethod,
  ): Promise<ClinicPaymentMethodEntity | null>;
  /** ¿Otro medio con el mismo nombre, sin distinguir mayúsculas? */
  nameTaken(name: string, exceptId?: string): Promise<boolean>;
  create(
    input: Required<PaymentMethodWriteInput>,
    userId: string,
  ): Promise<ClinicPaymentMethodEntity>;
  update(
    id: string,
    input: PaymentMethodWriteInput,
    userId: string,
  ): Promise<ClinicPaymentMethodEntity | null>;
  /**
   * DX-516: alta de un ajuste en el medio, con el medio bloqueado (tope de
   * activos y etiqueta única sin mayúsculas) y su evento de configuración
   * (DX-360) en la MISMA transacción.
   */
  createAdjustment(
    paymentMethodId: string,
    input: PaymentAdjustmentWriteInput,
    audit: AuditRequestContext,
  ): Promise<PaymentAdjustmentWriteResult>;
  /** DX-516: cambio de un ajuste (forma completa), con su antes y después. */
  updateAdjustment(
    paymentMethodId: string,
    adjustmentId: string,
    input: PaymentAdjustmentWriteInput,
    audit: AuditRequestContext,
  ): Promise<PaymentAdjustmentWriteResult>;
}
