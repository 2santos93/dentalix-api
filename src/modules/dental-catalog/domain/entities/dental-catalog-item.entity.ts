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
  /** DX-105: false = la prestación no admite descuentos (ni % de convenio ni discrecionales). */
  allowDiscount: boolean;
  active: boolean;
  /**
   * DX-455: plantilla de evolución ligada al procedimiento (el vínculo
   * guardado, aunque la plantilla esté desactivada); null = ninguna. Es lo que
   * edita la pantalla del catálogo.
   */
  clinicalNoteTemplateId: string | null;
  /**
   * DX-455: la plantilla que la web sugiere al marcar hecho el procedimiento:
   * `clinicalNoteTemplateId` si esa plantilla está ACTIVA; si no, null (una
   * desactivada no se sugiere).
   */
  suggestedClinicalNoteTemplateId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
