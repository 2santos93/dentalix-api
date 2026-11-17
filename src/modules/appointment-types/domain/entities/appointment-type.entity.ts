/**
 * Tipo de cita de la clínica (DX-121): fija la duración por defecto al agendar
 * y el color de la tarjeta en la agenda. Desactivarlo lo quita del selector;
 * retirarlo (`DELETE`, borrado lógico) lo quita también de la gestión. En
 * ningún caso cambia las citas que ya lo usan.
 */
export interface AppointmentType {
  id: string;
  tenantId: string;
  name: string;
  durationMinutes: number;
  /** `#RRGGBB`, siempre en mayúsculas. */
  color: string;
  active: boolean;
  /** DX-446: tipo de urgencia (los huecos reservados lo ofrecen primero). */
  isUrgent: boolean;
  /**
   * DX-564: indicaciones previas a la cita, `{ idioma BCP 47 → texto }`. `{}` =
   * sin indicaciones. Texto general de la clínica, nunca dato de un paciente.
   */
  preVisitInstructions: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

/** Lo que una cita embebe de su tipo (aunque luego se desactive o retire). */
export interface AppointmentTypeSummary {
  id: string;
  name: string;
  durationMinutes: number;
  color: string;
  /**
   * DX-564: si el tipo tiene indicaciones previas en algún idioma. Solo el
   * indicador: el texto se pide aparte para no inflar la agenda.
   */
  hasPreVisitInstructions: boolean;
}
