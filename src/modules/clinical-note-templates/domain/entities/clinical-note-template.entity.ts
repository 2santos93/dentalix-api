import type { NotePromptType } from '../note-template-rules';

/** Pregunta de una plantilla de evolución (DX-170), en su orden. */
export interface ClinicalNoteTemplatePrompt {
  id: string;
  /** También es el marcador del cuerpo: `{{Superficie}}`. */
  label: string;
  type: NotePromptType;
  /** ONE/MULTI: 1 a 20 opciones. TEXT: ninguna. */
  options: string[];
  defaultValue: string | null;
  position: number;
}

/**
 * Plantilla de evolución de la clínica (DX-170). No lleva datos de pacientes.
 * Desactivarla la quita del selector de «Nueva evolución»; ni eso ni editarla
 * cambia las evoluciones ya guardadas, que llevan su texto compuesto en
 * `notes` (DX-038).
 */
export interface ClinicalNoteTemplate {
  id: string;
  tenantId: string;
  name: string;
  /** Carpeta del selector; null = sin carpeta. */
  category: string | null;
  body: string;
  /**
   * DX-455: atajo para insertarla escribiendo en la nota («#resina»), tal como
   * se escribió; null = sin atajo. Único por clínica sin distinguir
   * mayúsculas y ninguno empieza por otro. Una desactivada lo conserva.
   */
  shortcut: string | null;
  active: boolean;
  /** DX-231: versión optimista; sube en 1 con cada edición. */
  version: number;
  prompts: ClinicalNoteTemplatePrompt[];
  createdAt: Date;
  updatedAt: Date;
}
