import { AgreementKind } from '@prisma/client';
import type { PayerType } from '../../../payers/domain/payer-type';

/**
 * Convenio de la clínica con un pagador (DX-105): o un descuento porcentual
 * (global y, opcionalmente, por categoría del catálogo) o una lista de
 * precios. Desactivarlo lo saca de la resolución de precios; retirarlo
 * (`DELETE`) lo quita de la gestión y solo se permite sin pacientes asignados.
 */
export interface Agreement {
  id: string;
  name: string;
  /**
   * `type` decide quién puede asignarlo (SEC-047): con un pagador externo
   * hace falta una cobertura viva del paciente con él; con `OTHER`, solo ADMIN.
   */
  payer: { id: string; name: string; type: PayerType };
  kind: AgreementKind;
  /** Solo `PERCENT_DISCOUNT` (0–100). */
  percent: number | null;
  /**
   * Solo `PERCENT_DISCOUNT`: `{ "<categoría del catálogo>": <0–100> }`, con la
   * ortografía de la categoría del catálogo. Gana sobre `percent`.
   */
  percentByCategory: Record<string, number> | null;
  /** Solo `PRICE_LIST`. */
  priceList: { id: string; name: string; currency: string } | null;
  /** `null` = toda la clínica. */
  locationId: string | null;
  /** Día civil `YYYY-MM-DD`; `null` = sin límite. */
  validFrom: string | null;
  validTo: string | null;
  active: boolean;
  /** Asignaciones vivas a pacientes. */
  assignedCount: number;
  createdAt: Date;
  updatedAt: Date;
}
