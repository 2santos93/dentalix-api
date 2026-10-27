import type { PatientLedger } from '../../../receivables/domain/entities/receivables.entity';
import type {
  CollectionNoteView,
  NewCollectionNote,
  NewPaymentPromise,
  OpenPromise,
  PatientCollectionRows,
  PatientPayment,
  PaymentPromiseRow,
} from '../collections.entity';
import type { PromiseStatus } from '../payment-promise-rule';

export const COLLECTIONS_REPOSITORY = Symbol('COLLECTIONS_REPOSITORY');

/**
 * Persistencia de la cobranza (DX-150). Todo bajo `runWithTenant` (RLS por
 * `app.current_tenant`) y con `tenantId` explícito. Sin el tenant en los
 * argumentos usa el del contexto (petición o trabajo de la cola).
 */
export interface CollectionsRepository {
  /** Paciente vivo de ESTA clínica (otro tenant o inexistente: false). */
  patientExists(patientId: string): Promise<boolean>;

  /** Sede viva de ESTA clínica. */
  locationExists(locationId: string): Promise<boolean>;

  /**
   * Sede por defecto de un compromiso sin sede activa: la de la deuda del
   * paciente (DX-155) o, sin ella, la primera sede activa de la clínica.
   */
  defaultLocationFor(patientId: string): Promise<string>;

  /** Zona IANA de la sede. */
  timeZoneOf(locationId: string): Promise<string>;

  currencyExists(code: string): Promise<boolean>;

  createNote(input: NewCollectionNote): Promise<CollectionNoteView>;

  /** `null` si el paciente ya tiene un compromiso abierto (índice único). */
  createPromise(input: NewPaymentPromise): Promise<PaymentPromiseRow | null>;

  /** Notas y compromisos del paciente, más recientes primero. */
  listForPatient(patientId: string): Promise<PatientCollectionRows>;

  /** Clínicas vivas (el barrido recorre una a una). */
  tenantIds(): Promise<string[]>;

  /** Compromisos OPEN de la clínica (o solo de ese paciente). */
  openPromises(tenantId: string, patientId?: string): Promise<OpenPromise[]>;

  /**
   * Abonos VIVOS de estos pacientes registrados desde `since`, en una
   * consulta (sin N+1).
   */
  paymentsSince(
    tenantId: string,
    patientIds: readonly string[],
    since: Date,
  ): Promise<PatientPayment[]>;

  /**
   * Cierra el compromiso si sigue OPEN y `decide` lo da por cerrado. En UNA
   * transacción con el candado de los compromisos del paciente (DX-215):
   * relee el compromiso y sus abonos vivos DESPUÉS de obtenerlo, así una
   * anulación simultánea no lo deja cumplido con un abono ya anulado. La
   * escritura es condicional (`UPDATE … WHERE status = 'OPEN'`): idempotente y
   * a prueba de carreras. Devuelve el estado al que lo pasó esta llamada, o
   * `null` si no lo cambió.
   */
  closePromise(
    tenantId: string,
    promiseId: string,
    decide: (promise: OpenPromise, payments: PatientPayment[]) => PromiseStatus,
  ): Promise<Exclude<PromiseStatus, 'OPEN'> | null>;

  /** Resumen financiero de estos pacientes con deuda (una consulta). */
  ledgersOf(patientIds: readonly string[]): Promise<PatientLedger[]>;

  /**
   * Zona de cada sede de la clínica y, para lo que no tiene sede, la de la
   * principal (R6), en un número fijo de consultas. Una sede sin zona solo
   * falla (409) si se busca su zona.
   */
  locationTimeZones(): Promise<(locationId: string | null) => string>;
}
