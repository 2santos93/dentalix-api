import type {
  DebtorCollections,
  DebtorDetails,
  PatientLedger,
} from '../entities/receivables.entity';

export const RECEIVABLES_REPOSITORY = Symbol('RECEIVABLES_REPOSITORY');

export interface ReceivablesLocation {
  id: string;
  name: string;
  /** IANA de la sede (su horario o su país, DX-097). */
  timeZone: string;
}

export interface LedgersQuery {
  /** Solo los pacientes cuya deuda es de esta sede; sin ella, toda la clínica. */
  locationId?: string;
}

export interface ReceivablesRepository {
  /**
   * Una sede viva de ESTA clínica con su zona, o `null` (inexistente, retirada
   * o de otra clínica: indistinguibles a propósito).
   */
  findLocation(locationId: string): Promise<ReceivablesLocation | null>;

  /**
   * Zona de cada sede de la clínica (incluidas las retiradas), para decidir el
   * «hoy» de cada deuda; sin sede, la de la principal (R6). Una sede sin zona
   * solo falla (409) si se busca su zona, es decir, si tiene deudas.
   */
  locationTimeZones(): Promise<(locationId: string | null) => string>;

  /**
   * Lo financiero de cada DEUDOR vivo de la clínica (de la sede pedida):
   * planes vivos con su facturable, abonos vivos sumados por plan y moneda, y
   * planes de pago con sus cuotas. Lo lee del resumen por paciente que
   * mantiene la BD (DX-155) en UNA consulta con RLS, sin N+1.
   */
  loadLedgers(query: LedgersQuery): Promise<PatientLedger[]>;

  /** Contacto y último abono vivo de estos pacientes (de esta clínica). */
  loadDebtors(patientIds: readonly string[]): Promise<DebtorDetails[]>;

  /**
   * DX-150: de estos pacientes, los que tienen un compromiso de pago OPEN
   * (filtro `hasPromise`). Una consulta por el índice parcial de abiertos.
   */
  patientsWithOpenPromise(patientIds: readonly string[]): Promise<Set<string>>;

  /**
   * DX-150: de estos pacientes, los que tuvo por última vez este profesional
   * (su última cita ATENDIDA, como la sede de la deuda). Filtro `providerId`.
   */
  patientsOfProvider(
    providerId: string,
    patientIds: readonly string[],
  ): Promise<Set<string>>;

  /** DX-150: última gestión y último compromiso de estos pacientes. */
  loadCollections(
    patientIds: readonly string[],
  ): Promise<Map<string, DebtorCollections>>;
}
