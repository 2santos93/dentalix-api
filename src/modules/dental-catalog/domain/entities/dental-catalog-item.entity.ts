import { CatalogKind } from '@prisma/client';

/**
 * API-facing shape of a DentalCatalogItem. Deliberately NOT the raw Prisma
 * model: repositories must `mapToEntity` before returning across the port
 * boundary (same convention as Patient — see patients module).
 * `defaultPrice` is a plain `number` here (Prisma returns `Decimal`).
 */
export interface DentalCatalogItem {
  id: string;
  tenantId: string;
  code: string;
  category: string | null;
  kind: CatalogKind;
  labelEs: string;
  labelEn: string | null;
  labelPt: string | null;
  color: string;
  defaultPrice: number | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}
