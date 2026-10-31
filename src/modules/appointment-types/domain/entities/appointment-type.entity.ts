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
  createdAt: Date;
  updatedAt: Date;
}

/** Lo que una cita embebe de su tipo (aunque luego se desactive o retire). */
export interface AppointmentTypeSummary {
  id: string;
  name: string;
  durationMinutes: number;
  color: string;
}
