import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { civilDateIn } from '../../../../shared/time/civil-day';
import {
  decideReminder,
  policyError,
  type BalanceReminderPolicy,
  type ReminderDecision,
} from '../../domain/balance-reminders';
import {
  BALANCE_REMINDERS_REPOSITORY,
  type BalanceRemindersRepository,
} from '../../domain/ports/balance-reminders-repository.port';
import { RECEIVABLES_REPOSITORY } from '../../domain/ports/receivables-repository.port';
import type { ReceivablesRepository } from '../../domain/ports/receivables-repository.port';
import {
  GetReceivablesAgingUseCase,
  RECEIVABLES_MAX_PAGE_SIZE,
  type AgingRowView,
  type DebtorAgingRow,
} from './get-receivables-aging.use-case';

export const BALANCE_REMINDERS_DEFAULT_PAGE_SIZE = 50;

export interface BalanceRemindersInput {
  /** Sede de la deuda; sin ella, las permitidas al miembro. */
  locationId?: string;
  page?: number;
  pageSize?: number;
}

export interface ReminderView {
  /** Tramo alcanzado (1 = primer umbral). */
  stage: number;
  /** Umbral del tramo, en días. */
  stageDays: number;
  /** Avisos ya dados para esta deuda. */
  noticesSent: number;
  /** Día civil (sede de la deuda) del último aviso de esta deuda. */
  lastNoticeOn: string | null;
}

export interface BalanceReminderRowView extends AgingRowView {
  reminder: ReminderView;
}

export interface BalanceRemindersPage {
  asOf: string;
  scope: { location: { id: string; name: string } | null };
  policy: BalanceReminderPolicy;
  items: BalanceReminderRowView[];
  total: number;
  page: number;
  pageSize: number;
  /**
   * Deudores a los que hoy tocaba avisar y que la lista deja fuera, por qué:
   * compromiso de pago abierto o baja de los avisos (DX-128). Sin nombres.
   */
  excluded: { openPromise: number; optedOut: number };
}

function whole(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

/**
 * «Por avisar hoy» de la cartera (DX-146): los deudores a los que hoy toca
 * avisar de su saldo vencido según la política de la clínica (tramos, tope de
 * avisos por deuda y días entre avisos; ver domain/balance-reminders.ts).
 * Fuera: quien tiene un compromiso de pago abierto, quien se dio de baja de
 * los avisos y quien ya no debe nada vencido (la antigüedad es la de la
 * cartera). Consultas fijas: la cartera, compromisos, bajas, avisos y el
 * detalle de la página.
 */
@Injectable()
export class GetBalanceRemindersUseCase {
  constructor(
    private readonly aging: GetReceivablesAgingUseCase,
    @Inject(BALANCE_REMINDERS_REPOSITORY)
    private readonly reminders: BalanceRemindersRepository,
    @Inject(RECEIVABLES_REPOSITORY)
    private readonly receivables: ReceivablesRepository,
  ) {}

  async execute(input: BalanceRemindersInput): Promise<BalanceRemindersPage> {
    const policy = await this.reminders.policy();
    const debtors = await this.aging.overdueDebtors({
      locationId: input.locationId,
      minAgeDays: policy.days[0],
    });
    const ids = debtors.rows.map((r) => r.patientId);
    const [promised, optedOut, notices] = await Promise.all([
      this.receivables.patientsWithOpenPromise(ids),
      this.reminders.patientsOptedOut(ids),
      this.reminders.noticesOf(ids),
    ]);

    const excluded = { openPromise: 0, optedOut: 0 };
    const due: { row: DebtorAgingRow; decision: ReminderDecision }[] = [];
    for (const row of debtors.rows) {
      const timeZone = debtors.zoneOf(row.locationId);
      const decision = decideReminder(policy, {
        today: civilDateIn(debtors.now, timeZone),
        oldestAgeDays: row.aging.oldestAgeDays,
        noticeDays: (notices.get(row.patientId) ?? []).map((at) =>
          civilDateIn(at, timeZone),
        ),
      });
      if (!decision.due) continue;
      if (promised.has(row.patientId)) {
        excluded.openPromise += 1;
      } else if (optedOut.has(row.patientId)) {
        excluded.optedOut += 1;
      } else {
        due.push({ row, decision });
      }
    }

    const page = whole(input.page, 1);
    const pageSize = Math.min(
      whole(input.pageSize, BALANCE_REMINDERS_DEFAULT_PAGE_SIZE),
      RECEIVABLES_MAX_PAGE_SIZE,
    );
    const slice = due.slice((page - 1) * pageSize, page * pageSize);
    const decisions = new Map(slice.map((d) => [d.row.patientId, d.decision]));
    const details = await this.aging.details(slice.map((d) => d.row));
    return {
      asOf: debtors.asOf,
      scope: debtors.scope,
      policy,
      items: details.map((row) => {
        const decision = decisions.get(row.patient.id) as ReminderDecision;
        return {
          ...row,
          reminder: {
            stage: decision.stage,
            stageDays: decision.stageDays as number,
            noticesSent: decision.noticesSent,
            lastNoticeOn: decision.lastNoticeOn,
          },
        };
      }),
      total: due.length,
      page,
      pageSize,
      excluded,
    };
  }
}

/**
 * Cambia la política de avisos de la clínica (DX-146). Solo ADMIN (lo decide
 * la ruta); valida con los mismos topes que el CHECK de la BD, con mensaje en
 * español, y deja el evento CLINIC_SETTINGS si algo cambió.
 */
@Injectable()
export class UpdateBalanceReminderPolicyUseCase {
  constructor(
    @Inject(BALANCE_REMINDERS_REPOSITORY)
    private readonly reminders: BalanceRemindersRepository,
  ) {}

  async execute(
    next: BalanceReminderPolicy,
    ctx: AuditRequestContext,
  ): Promise<BalanceReminderPolicy> {
    const policy: BalanceReminderPolicy = {
      days: [...next.days],
      maxNotices: next.maxNotices,
      minGapDays: next.minGapDays,
    };
    const error = policyError(policy);
    if (error) throw new BadRequestException(error);
    const { after } = await this.reminders.setPolicy(policy, ctx);
    return after;
  }
}
