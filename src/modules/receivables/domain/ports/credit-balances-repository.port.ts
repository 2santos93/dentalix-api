import type { PlanCreditFacts } from '../entities/credit-balances.entity';
import type { PatientLedger } from '../entities/receivables.entity';
import type { ReceivablesRepository } from './receivables-repository.port';

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
   * saldo a favor, en UNA consulta con RLS. Sin filtro de sede: la sede de
   * cada saldo se atribuye por plan (`planCreditFacts`). Es un SUPERCONJUNTO
   * de quien lo tiene en `computeBalances`: la cifra la calcula la aplicación
   * con el mismo núcleo del estado de cuenta.
   */
  loadCreditLedgers(): Promise<PatientLedger[]>;

  /**
   * Sedes a las que el miembro tiene acceso (DX-089); `undefined` = todas.
   */
  allowedLocationIds(): string[] | undefined;

  /** Nombre completo de estos pacientes vivos (de esta clínica). */
  patientNames(patientIds: readonly string[]): Promise<Map<string, string>>;

  /** Nombre de cada sede de la clínica (incluidas las retiradas). */
  locationNames(): Promise<Map<string, string>>;

  /**
   * Para cada uno de estos planes, los hechos con los que se atribuye su
   * saldo a una sede y se fecha: su sede, sus abonos vivos por orden
   * cronológico y, si no tiene propios, los de los planes que le traspasaron
   * saldo (recursivo).
   */
  planCreditFacts(
    planIds: readonly string[],
  ): Promise<Map<string, PlanCreditFacts>>;
}
