import type { PaymentMethod, PaymentMethodKind } from '@prisma/client';
import type { ClinicPaymentMethodEntity } from '../payment-method.entity';

export const PAYMENT_METHOD_REPOSITORY = Symbol('PAYMENT_METHOD_REPOSITORY');

export interface PaymentMethodWriteInput {
  name?: string;
  kind?: PaymentMethodKind;
  active?: boolean;
  requiresReference?: boolean;
}

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
}
