import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { BalanceReminderPolicy } from '../balance-reminders';

export const BALANCE_REMINDERS_REPOSITORY = Symbol(
  'BALANCE_REMINDERS_REPOSITORY',
);

/**
 * «Por avisar hoy» (DX-146). Todo bajo `runWithTenant` (RLS) y con el tenant
 * del contexto, en un número fijo de consultas por lista (sin N+1).
 */
export interface BalanceRemindersRepository {
  /** La política de la clínica (columnas de `tenants`). */
  policy(): Promise<BalanceReminderPolicy>;

  /**
   * Cambia la política. En UNA transacción con la fila bloqueada: lee, escribe
   * y deja el `audit_event` (CLINIC_SETTINGS, antes y después) si algo cambió.
   */
  setPolicy(
    next: BalanceReminderPolicy,
    ctx: AuditRequestContext,
  ): Promise<{ before: BalanceReminderPolicy; after: BalanceReminderPolicy }>;

  /** De estos pacientes, los dados de baja de los avisos (DX-128). */
  patientsOptedOut(patientIds: readonly string[]): Promise<Set<string>>;

  /** Instantes de los avisos (notas REMINDER_SENT) de estos pacientes. */
  noticesOf(patientIds: readonly string[]): Promise<Map<string, Date[]>>;
}
