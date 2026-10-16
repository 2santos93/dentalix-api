import {
  StatementClinic,
  StatementPatient,
  StatementSnapshot,
} from '../entities/account-statement.entity';
import { BillablePlanRow } from '../entities/billable-plan.entity';

export const ACCOUNT_STATEMENT_REPOSITORY = Symbol(
  'ACCOUNT_STATEMENT_REPOSITORY',
);

export interface AccountStatementData {
  clinic: StatementClinic;
  patient: StatementPatient;
  snapshot: StatementSnapshot;
}

export interface AccountStatementRepository {
  /**
   * Todo lo que necesita el estado de cuenta de un paciente, leído en UNA
   * transacción con RLS (misma foto para todas las consultas), o `null` si el
   * paciente no existe, está retirado o es de otra clínica — los tres casos
   * son indistinguibles a propósito (mismo 404, sin revelar si el UUID existe
   * en otro tenant).
   */
  load(patientId: string): Promise<AccountStatementData | null>;

  /**
   * Los planes vivos del paciente con su facturable, sus abonos vivos por
   * moneda y si tienen un plan de pagos activo (DX-067), o `null` con el mismo
   * criterio que `load`. Sin ítems, notas ni nada clínico.
   */
  loadBillablePlans(patientId: string): Promise<BillablePlanRow[] | null>;
}
