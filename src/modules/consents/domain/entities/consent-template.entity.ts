/**
 * Plantilla de consentimiento de la clínica (DX-006). Editable: cada cambio
 * de título o texto sube `version`, que el consentimiento firmado guarda para
 * saber de qué versión salió. Nunca se borra: se desactiva (`active: false`).
 */
export interface ConsentTemplate {
  id: string;
  tenantId: string;
  title: string;
  body: string;
  active: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
