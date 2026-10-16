/**
 * Adenda (nota aclaratoria) de una evolución — DX-038, Res. 1995/1999 art. 18.
 *
 * Corrige un asiento de la historia clínica SIN tocarlo: el original queda
 * intacto y la adenda se lista debajo, con su motivo, su autor y la fecha en
 * que la grabó el servidor. Como la evolución, es INALTERABLE: no hay método
 * de repositorio ni ruta para editarla o borrarla, y la BD lo impide (trigger).
 */
export interface ClinicalEntryAddendum {
  id: string;
  tenantId: string;
  patientId: string;
  clinicalEntryId: string;
  reason: string;
  text: string;
  /** Usuario autenticado que la escribió (del JWT, nunca del cuerpo). */
  authorId: string;
  /** Fecha de registro: la fija el servidor de BD en el INSERT. */
  createdAt: Date;
}
