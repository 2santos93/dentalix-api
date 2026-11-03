import {
  StatementClinic,
  StatementPatient,
  StatementSnapshot,
} from '../entities/account-statement.entity';
import type { DocumentRegionalDto } from '../../../../shared/locations/document-regional.dto';
import { BillablePlanRow } from '../entities/billable-plan.entity';
import type { PlanBalanceInput } from '../../../payments/application/use-cases/get-plan-balance.use-case';

export const ACCOUNT_STATEMENT_REPOSITORY = Symbol(
  'ACCOUNT_STATEMENT_REPOSITORY',
);

export interface AccountStatementData {
  clinic: StatementClinic;
  /** DX-354: región de la sede en contexto (o la principal); `null` si le falta algo. */
  regional: DocumentRegionalDto | null;
  patient: StatementPatient;
  snapshot: StatementSnapshot;
  /** DX-472: lo que `GetPlanBalanceUseCase` necesita, de la misma foto. */
  planBalances: PlanBalanceInput[];
}

export interface AccountStatementRepository {
  /**
   * DX-354: región de la sede en contexto (o la principal), leída UNA vez; la
   * usa el estado de cuenta familiar en lugar de una lectura por miembro.
   */
  loadRegional(): Promise<DocumentRegionalDto | null>;

  /**
   * Todo lo que necesita el estado de cuenta de un paciente, leído en UNA
   * transacción con RLS (misma foto para todas las consultas), o `null` si el
   * paciente no existe, está retirado o es de otra clínica — los tres casos
   * son indistinguibles a propósito (mismo 404, sin revelar si el UUID existe
   * en otro tenant).
   */
  load(
    patientId: string,
    options?: { regional?: boolean },
  ): Promise<AccountStatementData | null>;

  /**
   * Los planes vivos del paciente con su facturable, sus abonos vivos por
   * moneda y si tienen un plan de pagos activo (DX-067), o `null` con el mismo
   * criterio que `load`. Sin ítems, notas ni nada clínico.
   */
  loadBillablePlans(patientId: string): Promise<BillablePlanRow[] | null>;
}
