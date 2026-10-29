import type { PayerType } from '../payer-type';

/**
 * Pagador de la clínica (DX-153): aseguradora, plan prepago, sistema público,
 * empresa u otro.
 * Desactivarlo lo quita de los selectores; retirarlo (`DELETE`) lo quita de la
 * gestión y solo se permite sin coberturas vivas. Las coberturas ya creadas
 * nunca cambian por esto.
 */
export interface Payer {
  id: string;
  name: string;
  type: PayerType;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}
