import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { addCivilDays } from '../../../shared/time/civil-day';
import {
  accrualLines,
  adjustmentLines,
  planReleasedAt,
  totalsByCurrency,
  type CommissionLineDraft,
  type SettlementPeriod,
} from '../domain/commission-calculator';
import {
  COMMISSION_DEDUCTIONS_AVAILABLE,
  parseRuleTerms,
  type CommissionRuleTerms,
  type RuleTermsInput,
} from '../domain/commission-rule';
import {
  CLOSE_BLOCKER_MESSAGES,
  closeBlocker,
  parseSettlementPeriod,
  type CloseBlocker,
} from '../domain/settlement-period';
import {
  COMMISSION_CLOCK,
  COMMISSION_REPOSITORY,
  type CommissionClock,
  type CommissionProfessional,
  type CommissionReader,
  type CommissionRepository,
  type CommissionRuleRecord,
} from '../domain/ports/commission-repository.port';
import type {
  CommissionLineView,
  CommissionPreviewView,
  CommissionRulesView,
  CommissionSettlementSummary,
  CommissionSettlementView,
  ProfessionalRuleView,
  ProfessionalView,
  RuleView,
} from '../domain/views';

export interface CommissionActor {
  userId: string;
  role: ClinicRole;
}

export const COMMISSION_MESSAGES = {
  allLocations:
    'Los honorarios son de toda la clínica: solo un administrador con acceso a todas las sedes los configura, liquida y consulta.',
  notFound: 'Profesional no encontrado en esta clínica.',
  settlementNotFound: 'Liquidación no encontrada.',
  notProfessional:
    'Solo se configuran honorarios de odontólogos y administradores que realizan prestaciones.',
  retired:
    'Este profesional ya no está en la clínica: su regla no se puede cambiar.',
} as const;

const SETTLEMENTS_LIST_LIMIT = 200;
/** ±14 h: un día civil en cualquier zona cae dentro (UTC−12 … UTC+14). */
const ZONE_SLACK_MS = 14 * 60 * 60 * 1000;

function professionalView(p: CommissionProfessional): ProfessionalView {
  return {
    userId: p.userId,
    membershipId: p.membershipId,
    name: p.name,
    role: p.role,
    active: p.active,
  };
}

function ruleView(rule: CommissionRuleRecord): RuleView {
  return {
    id: rule.id,
    basis: rule.terms.basis,
    releaseMode: rule.terms.releaseMode,
    percent: rule.terms.percent,
    categories: rule.terms.categories,
    active: rule.active,
    deductLabCost: rule.terms.deductLabCost,
    deductCardFee: rule.terms.deductCardFee,
    updatedAt: rule.updatedAt,
  };
}

function cannotClose(blocker: CloseBlocker): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'COMMISSION_CANNOT_CLOSE',
    blocker,
    message: CLOSE_BLOCKER_MESSAGES[blocker],
  });
}

/**
 * DX-018: honorarios de odontólogos. ADMIN (con todas las sedes) configura,
 * previsualiza, cierra y consulta; un DENTIST solo ve lo suyo (su vista previa
 * y sus liquidaciones): lo ajeno es 404, comprobado aquí y no solo en la web.
 */
@Injectable()
export class CommissionUseCases {
  constructor(
    @Inject(COMMISSION_REPOSITORY) private readonly repo: CommissionRepository,
    @Inject(COMMISSION_CLOCK) private readonly now: CommissionClock,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** El ADMIN ve toda la clínica: sin restricción de sedes (DX-089). */
  private assertClinicWide(actor: CommissionActor): void {
    if (
      actor.role === ClinicRole.ADMIN &&
      this.tenantContext.getAllowedLocationIds() !== 'ALL'
    ) {
      throw new ForbiddenException(COMMISSION_MESSAGES.allLocations);
    }
  }

  /**
   * El profesional que el actor puede ver: un DENTIST, solo él mismo (otro
   * usuario → 404, sin decir si existe); un ADMIN, cualquiera de la clínica.
   */
  private async visibleProfessional(
    actor: CommissionActor,
    userId: string | undefined,
  ): Promise<CommissionProfessional> {
    this.assertClinicWide(actor);
    const target = userId ?? actor.userId;
    if (actor.role !== ClinicRole.ADMIN && target !== actor.userId) {
      throw new NotFoundException(COMMISSION_MESSAGES.notFound);
    }
    const professional = await this.repo.findProfessional(target);
    if (!professional)
      throw new NotFoundException(COMMISSION_MESSAGES.notFound);
    return professional;
  }

  async listRules(actor: CommissionActor): Promise<CommissionRulesView> {
    this.assertClinicWide(actor);
    const [rows, categories] = await Promise.all([
      this.repo.listProfessionals(),
      this.repo.listCategories(),
    ]);
    return {
      professionals: rows.map((r) => ({
        professional: professionalView(r.professional),
        rule: r.rule ? ruleView(r.rule) : null,
      })),
      categories,
      deductionsAvailable: { ...COMMISSION_DEDUCTIONS_AVAILABLE },
    };
  }

  async saveRule(
    actor: CommissionActor,
    userId: string,
    input: RuleTermsInput & { active?: boolean },
    ctx: AuditRequestContext,
  ): Promise<ProfessionalRuleView> {
    const professional = await this.visibleProfessional(actor, userId);
    if (
      professional.role !== ClinicRole.DENTIST &&
      professional.role !== ClinicRole.ADMIN
    ) {
      throw new BadRequestException(COMMISSION_MESSAGES.notProfessional);
    }
    if (!professional.active) {
      throw new BadRequestException(COMMISSION_MESSAGES.retired);
    }
    const parsed = parseRuleTerms(input);
    if (!parsed.ok) throw new BadRequestException(parsed.message);
    const rule = await this.repo.saveRule(
      professional,
      parsed.terms,
      input.active ?? true,
      ctx,
    );
    return {
      professional: professionalView(professional),
      rule: ruleView(rule),
    };
  }

  private period(from: string, to: string): SettlementPeriod {
    const parsed = parseSettlementPeriod(from, to);
    if (!parsed.ok) throw new BadRequestException(parsed.message);
    return parsed.period;
  }

  /** Devengos del período + ajustes de liquidaciones anteriores. */
  private async computeLines(
    reader: CommissionReader,
    professional: CommissionProfessional,
    terms: CommissionRuleTerms,
    period: SettlementPeriod,
  ): Promise<CommissionLineDraft[]> {
    const window = {
      start: new Date(
        Date.parse(`${period.from}T00:00:00.000Z`) - ZONE_SLACK_MS,
      ),
      end: new Date(
        Date.parse(`${addCivilDays(period.to, 1)}T00:00:00.000Z`) +
          ZONE_SLACK_MS,
      ),
    };
    const candidates = await reader.candidates(professional, terms, window);
    const planRelease = new Map<string, Date | null>();
    if (terms.releaseMode === 'PER_PLAN') {
      const infos = await reader.planRelease(candidates.map((c) => c.planId));
      for (const info of infos)
        planRelease.set(info.planId, planReleasedAt(info));
    }
    const accruals = accrualLines(candidates, terms, period, planRelease);
    const adjustments = adjustmentLines(
      await reader.settledToAdjust(professional),
    );
    return [...accruals, ...adjustments];
  }

  private async lineViews(
    reader: CommissionReader,
    lines: readonly CommissionLineDraft[],
  ): Promise<CommissionLineView[]> {
    const names = await reader.patientNames(lines.map((l) => l.patientId));
    return lines.map((l) => ({
      id: null,
      kind: l.kind,
      adjustsLineId: l.adjustsLineId,
      patient: { id: l.patientId, name: names.get(l.patientId) ?? null },
      treatmentPlanId: l.planId,
      treatmentPlanItemId: l.itemId,
      locationId: l.locationId,
      catalogCode: l.catalogCode,
      catalogLabel: l.catalogLabel,
      category: l.category,
      toothNumber: l.toothNumber,
      completedAt: l.completedAt,
      payment:
        l.paymentId !== null &&
        l.paidAt !== null &&
        l.paymentAmount !== null &&
        l.paymentCurrency !== null
          ? {
              id: l.paymentId,
              paidAt: l.paidAt,
              amount: l.paymentAmount,
              currency: l.paymentCurrency,
            }
          : null,
      releasedAt: l.releasedAt,
      currency: l.currency,
      base: l.base,
      percent: l.percent,
      amount: l.amount,
    }));
  }

  async preview(
    actor: CommissionActor,
    query: { userId?: string; from: string; to: string },
  ): Promise<CommissionPreviewView> {
    const period = this.period(query.from, query.to);
    const professional = await this.visibleProfessional(actor, query.userId);
    const now = this.now();
    return this.repo.read(async (reader) => {
      const [rule, lastClosedTo, overlaps, today] = await Promise.all([
        reader.rule(professional.membershipId),
        reader.lastClosedTo(professional.membershipId),
        reader.overlaps(professional.membershipId, period),
        reader.today(now),
      ]);
      const lines = rule
        ? await this.computeLines(reader, professional, rule.terms, period)
        : [];
      const blocker = closeBlocker({
        period,
        today,
        lastClosedTo,
        overlaps,
        rule,
      });
      return {
        professional: professionalView(professional),
        period,
        rule: rule ? ruleView(rule) : null,
        lines: await this.lineViews(reader, lines),
        totals: totalsByCurrency(lines),
        lastClosedTo,
        nextFrom: lastClosedTo === null ? null : addCivilDays(lastClosedTo, 1),
        canClose: blocker === null,
        blocker,
        blockerMessage:
          blocker === null ? null : CLOSE_BLOCKER_MESSAGES[blocker],
        deductionsAvailable: { ...COMMISSION_DEDUCTIONS_AVAILABLE },
      };
    });
  }

  async close(
    actor: CommissionActor,
    input: { userId: string; from: string; to: string },
    ctx: AuditRequestContext,
  ): Promise<CommissionSettlementView> {
    const period = this.period(input.from, input.to);
    const professional = await this.visibleProfessional(actor, input.userId);
    const now = this.now();
    const closed = await this.repo.close(
      professional.membershipId,
      async (reader) => {
        const [rule, lastClosedTo, overlaps, today] = await Promise.all([
          reader.rule(professional.membershipId),
          reader.lastClosedTo(professional.membershipId),
          reader.overlaps(professional.membershipId, period),
          reader.today(now),
        ]);
        const blocker = closeBlocker({
          period,
          today,
          lastClosedTo,
          overlaps,
          rule,
        });
        if (blocker !== null || rule === null) {
          throw cannotClose(blocker ?? 'NO_RULE');
        }
        const lines = await this.computeLines(
          reader,
          professional,
          rule.terms,
          period,
        );
        return { professional, period, terms: rule.terms, lines };
      },
      ctx,
    );
    const view = await this.repo.getSettlement(closed.id);
    if (!view)
      throw new NotFoundException(COMMISSION_MESSAGES.settlementNotFound);
    return {
      ...view.summary,
      categoryPercents: view.categoryPercents,
      lines: view.lines,
    };
  }

  async listSettlements(
    actor: CommissionActor,
    userId: string | undefined,
  ): Promise<CommissionSettlementSummary[]> {
    this.assertClinicWide(actor);
    if (actor.role !== ClinicRole.ADMIN) {
      if (userId !== undefined && userId !== actor.userId) return [];
      return this.repo.listSettlements({
        userId: actor.userId,
        limit: SETTLEMENTS_LIST_LIMIT,
      });
    }
    return this.repo.listSettlements({ userId, limit: SETTLEMENTS_LIST_LIMIT });
  }

  async getSettlement(
    actor: CommissionActor,
    id: string,
  ): Promise<CommissionSettlementView> {
    this.assertClinicWide(actor);
    const found = await this.repo.getSettlement(id);
    if (
      !found ||
      (actor.role !== ClinicRole.ADMIN &&
        found.summary.professional.userId !== actor.userId)
    ) {
      throw new NotFoundException(COMMISSION_MESSAGES.settlementNotFound);
    }
    return {
      ...found.summary,
      categoryPercents: found.categoryPercents,
      lines: found.lines,
    };
  }
}
