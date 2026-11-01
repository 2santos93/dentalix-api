/**
 * Sillón (gabinete) de una sede (DX-211): recurso físico de la cita. Una
 * clínica sin sillones sigue igual (la cita no lo exige). No se borra: se
 * desactiva, y sus citas lo conservan con su nombre.
 */
export interface Chair {
  id: string;
  tenantId: string;
  locationId: string;
  name: string;
  /** Orden de la columna en la agenda (0–999); empate por nombre. */
  sortOrder: number;
  /** Profesional que se propone al elegir el sillón, o `null`. */
  defaultProviderId: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Lo que una cita embebe de su sillón (aunque luego se desactive). */
export interface ChairSummary {
  id: string;
  name: string;
  active: boolean;
}
