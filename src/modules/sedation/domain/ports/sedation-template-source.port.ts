import type { SedationTemplate } from '../sedation-template';

export const SEDATION_TEMPLATE_SOURCE = Symbol('SEDATION_TEMPLATE_SOURCE');

/**
 * De dónde sale la plantilla de la hoja de sedación (DX-407). Hoy, la de
 * plataforma fija en el código; DX-409 la sustituirá por la de cada clínica
 * (Ajustes) implementando este mismo puerto, sin tocar reglas ni casos de uso.
 */
export interface SedationTemplateSource {
  /** Plantilla con la que se abre una hoja nueva en la clínica del contexto. */
  current(): Promise<SedationTemplate>;
  /** Plantilla con la que se abrió una hoja (por su versión guardada). */
  byVersion(version: string): Promise<SedationTemplate | null>;
}
