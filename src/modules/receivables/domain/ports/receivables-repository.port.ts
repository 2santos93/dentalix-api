import type {
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
   * «hoy» de cada deuda.
   */
  locationTimeZones(): Promise<Map<string, string>>;

  /**
   * Lo financiero de cada paciente vivo de la clínica con algún plan vivo, de
   * la sede pedida: planes con su facturable, abonos vivos sumados por plan y
   * moneda, y planes de pago con sus cuotas. Número FIJO de consultas (sin
   * N+1), en UNA transacción REPEATABLE READ con RLS.
   */
  loadLedgers(query: LedgersQuery): Promise<PatientLedger[]>;

  /** Contacto y último abono vivo de estos pacientes (de esta clínica). */
  loadDebtors(patientIds: readonly string[]): Promise<DebtorDetails[]>;
}
