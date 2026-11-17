import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ClinicRole } from '@prisma/client';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { civilDateIn } from '../../../shared/time/civil-day';
import {
  lockedThroughAt,
  mayOverrideLock,
  type FinancialLockSettings,
} from '../domain/financial-lock';
import {
  FINANCIAL_LOCK_OVERRIDES_LIMIT,
  applyFinancialLockPatch,
  type FinancialLockPatchInput,
  type FinancialLockSettingsView,
  type PeriodLockView,
} from '../domain/financial-lock-settings';
import {
  FINANCIAL_LOCK_REPOSITORY,
  type FinancialLockRepository,
} from '../domain/ports/financial-lock-repository.port';

export type FinancialLockClock = () => Date;
export const FINANCIAL_LOCK_CLOCK = Symbol('FINANCIAL_LOCK_CLOCK');

/** DX-091: Ajustes › Caja › Cierre contable (solo ADMIN, lo exige la ruta). */
@Injectable()
export class GetFinancialLockUseCase {
  constructor(
    @Inject(FINANCIAL_LOCK_REPOSITORY)
    private readonly repo: FinancialLockRepository,
    @Inject(FINANCIAL_LOCK_CLOCK) private readonly now: FinancialLockClock,
  ) {}

  async execute(): Promise<FinancialLockSettingsView> {
    const settings = await this.repo.get();
    return this.view(settings);
  }

  async view(
    settings: FinancialLockSettings,
  ): Promise<FinancialLockSettingsView> {
    const [timeZone, overrides] = await Promise.all([
      this.repo.siteTimeZone(),
      this.repo.listOverrides(FINANCIAL_LOCK_OVERRIDES_LIMIT),
    ]);
    return {
      ...settings,
      lockedThrough: lockedThroughAt(settings, this.now(), timeZone),
      overrides,
    };
  }
}

/**
 * DX-091: cambia el cierre. Ausente = no cambia; `null` = sin ese cierre. La
 * fecha fija tiene que ser anterior a hoy en la sede de quien lo cambia.
 * Queda en la auditoría con el antes y el después.
 */
@Injectable()
export class UpdateFinancialLockUseCase {
  constructor(
    @Inject(FINANCIAL_LOCK_REPOSITORY)
    private readonly repo: FinancialLockRepository,
    @Inject(FINANCIAL_LOCK_CLOCK) private readonly now: FinancialLockClock,
    private readonly getLock: GetFinancialLockUseCase,
  ) {}

  async execute(
    input: FinancialLockPatchInput,
    ctx: AuditRequestContext,
  ): Promise<FinancialLockSettingsView> {
    const today = civilDateIn(this.now(), await this.repo.siteTimeZone());
    const saved = await this.repo.update((current) => {
      const parsed = applyFinancialLockPatch(current, input, today);
      if (!parsed.ok) throw new BadRequestException(parsed.message);
      return parsed.next;
    }, ctx);
    return this.getLock.view(saved);
  }
}

/**
 * DX-091: el cierre que rige hoy en la sede de la petición, para el
 * selector de fecha del abono, y si quien pregunta puede saltarlo.
 */
@Injectable()
export class GetPeriodLockUseCase {
  constructor(
    @Inject(FINANCIAL_LOCK_REPOSITORY)
    private readonly repo: FinancialLockRepository,
    @Inject(FINANCIAL_LOCK_CLOCK) private readonly now: FinancialLockClock,
  ) {}

  async execute(role: ClinicRole): Promise<PeriodLockView> {
    const settings = await this.repo.get();
    if (settings.lockDate === null && settings.lockDays === null) {
      return { lockedThrough: null, canOverride: false };
    }
    const timeZone = await this.repo.siteTimeZone();
    return {
      lockedThrough: lockedThroughAt(settings, this.now(), timeZone),
      canOverride: mayOverrideLock(settings, role),
    };
  }
}
