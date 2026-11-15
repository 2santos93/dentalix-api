import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type {
  PaymentInstructionFields,
  PaymentMethodInstruction,
} from '../payment-method-instructions';

export const PAYMENT_METHOD_INSTRUCTION_REPOSITORY = Symbol(
  'PAYMENT_METHOD_INSTRUCTION_REPOSITORY',
);

export type InstructionWriteResult =
  | { ok: true; instruction: PaymentMethodInstruction }
  | { ok: false; reason: 'METHOD_NOT_FOUND' | 'LOCATION_NOT_FOUND' };

/** Datos para pagar de la clínica del contexto (DX-569, bajo RLS). */
export interface PaymentMethodInstructionRepository {
  /** Los de un medio (la clínica y cada sede); `null` si el medio no existe. */
  listByMethod(
    paymentMethodId: string,
  ): Promise<PaymentMethodInstruction[] | null>;
  /** Todos los de la clínica (el enlace elige por sede). */
  listAll(): Promise<PaymentMethodInstruction[]>;
  /**
   * Alta o cambio de los de un medio en una sede (`null` = la clínica), con
   * el medio bloqueado y su evento de configuración en la misma transacción.
   */
  upsert(
    paymentMethodId: string,
    locationId: string | null,
    fields: PaymentInstructionFields,
    audit: AuditRequestContext,
  ): Promise<InstructionWriteResult>;
  /** Quita una fila (vuelve a regir la de la clínica); `null` si no existe. */
  remove(
    paymentMethodId: string,
    instructionId: string,
    audit: AuditRequestContext,
  ): Promise<PaymentMethodInstruction | null>;
}
