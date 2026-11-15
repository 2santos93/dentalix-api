import type { VisitIntervals } from '../plan-template-rules';

/** Línea de una plantilla de plan (DX-559), en su orden. */
export interface TreatmentPlanTemplateLine {
  id: string;
  position: number;
  catalogItemId: string;
  /** Nombre y código del procedimiento, para la pantalla. */
  catalogItemLabel: string;
  catalogItemCode: string;
  /**
   * false si el procedimiento está desactivado o retirado del catálogo: al
   * aplicar la plantilla esa línea se omite (D6).
   */
  catalogItemActive: boolean;
  /** N ítems iguales al aplicar (1–20). */
  quantity: number;
  /** Visita de la plantilla (1–50). */
  visit: number;
  visitLabel: string | null;
  /** La vista previa ofrece las superficies (opcionales). */
  asksSurfaces: boolean;
}

/**
 * Plantilla de plan de tratamiento de la clínica (DX-559). Sin precios ni
 * descuentos ni datos de pacientes. Desactivarla la quita del selector;
 * ni eso ni editarla cambia los planes ya creados (D11).
 */
export interface TreatmentPlanTemplate {
  id: string;
  tenantId: string;
  name: string;
  active: boolean;
  /** Versión optimista: sube en 1 con cada edición. */
  version: number;
  visitIntervals: VisitIntervals;
  lines: TreatmentPlanTemplateLine[];
  createdAt: Date;
  updatedAt: Date;
}
