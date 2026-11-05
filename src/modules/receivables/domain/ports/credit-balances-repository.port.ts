import type { PatientLedger } from '../entities/receivables.entity';
import type {
  LedgersQuery,
  ReceivablesRepository,
} from './receivables-repository.port';

export const CREDIT_BALANCES_REPOSITORY = Symbol('CREDIT_BALANCES_REPOSITORY');

/**
 * Lecturas de «Saldo a favor» (DX-430). Comparte con la cartera por
 * antigüedad la sede y las zonas; el resto es propio de esta lista.
 */
export interface CreditBalancesRepository extends Pick<
  ReceivablesRepository,
  'findLocation' | 'locationTimeZones'
> {
  /**
   * El resumen `patient_ledgers` de los pacientes VIVOS que pueden tener
   * saldo a favor (de la sede pedida, o las permitidas al miembro), en UNA
   * consulta con RLS. Es un SUPERCONJUNTO de quien lo tiene en
   * `computeBalances`: la cifra la calcula la aplicación con el mismo núcleo
   * del estado de cuenta; aquí solo se descarta a quien seguro no tiene.
   */
  loadCreditLedgers(query: LedgersQuery): Promise<PatientLedger[]>;

  /** Nombre completo de estos pacientes vivos (de esta clínica). */
  patientNames(patientIds: readonly string[]): Promise<Map<string, string>>;

  /** Nombre de cada sede de la clínica (incluidas las retiradas). */
  locationNames(): Promise<Map<string, string>>;

  /**
   * Para cada uno de estos planes, el instante del abono vivo MÁS ANTIGUO que
   * origina su saldo: el de sus propios abonos o, si lo recibió por traspaso,
   * el de los planes de los que vino (recursivo). Un plan sin abonos en ese
   * árbol no sale.
   */
  oldestCreditPayments(planIds: readonly string[]): Promise<Map<string, Date>>;
}
