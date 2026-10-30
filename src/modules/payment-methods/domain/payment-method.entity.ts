import type { PaymentMethod, PaymentMethodKind } from '@prisma/client';

/** Un medio de pago del catálogo de la clínica (DX-377). */
export interface ClinicPaymentMethodEntity {
  id: string;
  tenantId: string;
  name: string;
  kind: PaymentMethodKind;
  active: boolean;
  requiresReference: boolean;
  /** Medio inicial equivalente a este método antiguo; `null` si es propio. */
  legacyMethod: PaymentMethod | null;
  createdAt: Date;
  updatedAt: Date;
}
