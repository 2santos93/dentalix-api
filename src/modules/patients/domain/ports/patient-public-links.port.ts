import type { LivePublicLinkCounts } from '../live-public-links';

export const PATIENT_PUBLIC_LINKS_READER = Symbol(
  'PATIENT_PUBLIC_LINKS_READER',
);

/** DX-461: lo que archivar anularía, para avisar antes en el diálogo. */
export interface PatientPublicLinksReader {
  /**
   * Enlaces públicos vivos a `now` del paciente vivo `patientId`, en todas
   * las sedes (el paciente es de la clínica). `null` si no existe en la
   * clínica del contexto o ya está archivado.
   */
  countLive(patientId: string, now: Date): Promise<LivePublicLinkCounts | null>;
}
