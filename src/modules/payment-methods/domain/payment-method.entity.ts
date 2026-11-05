import type {
  PaymentProofPolicy,
  PaymentAdjustmentCalculation,
  PaymentAdjustmentType,
  PaymentMethod,
  PaymentMethodKind,
} from '@prisma/client';

/**
 * DX-516: un ajuste configurado en un medio de pago (impuesto, recargo o
 * descuento). PERCENT lleva `percent`; FIXED, `fixedAmount` y su moneda.
 */
export interface PaymentMethodAdjustmentEntity {
  id: string;
  paymentMethodId: string;
  type: PaymentAdjustmentType;
  label: string;
  calculation: PaymentAdjustmentCalculation;
  percent: number | null;
  fixedAmount: number | null;
  fixedCurrency: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Un medio de pago del catálogo de la clínica (DX-377). */
export interface ClinicPaymentMethodEntity {
  id: string;
  tenantId: string;
  name: string;
  kind: PaymentMethodKind;
  active: boolean;
  requiresReference: boolean;
  /** DX-389: «Pide comprobante» del cobro: NONE (defecto), OPTIONAL o REQUIRED. */
  proofPolicy: PaymentProofPolicy;
  /** Medio inicial equivalente a este método antiguo; `null` si es propio. */
  legacyMethod: PaymentMethod | null;
  /**
   * DX-516: sus ajustes (activos o no), en el orden en que se crearon.
   * Vacío por defecto: ningún medio trae ajustes.
   */
  adjustments: PaymentMethodAdjustmentEntity[];
  createdAt: Date;
  updatedAt: Date;
}
