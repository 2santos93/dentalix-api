import { ClinicCountry, PayerType } from '@prisma/client';

/**
 * Pagador de la clínica (DX-153): mutua, prepagada, EPS, empresa u otro.
 * Desactivarlo lo quita de los selectores; retirarlo (`DELETE`) lo quita de la
 * gestión y solo se permite sin coberturas vivas. Las coberturas ya creadas
 * nunca cambian por esto.
 */
export interface Payer {
  id: string;
  name: string;
  type: PayerType;
  country: ClinicCountry | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}
