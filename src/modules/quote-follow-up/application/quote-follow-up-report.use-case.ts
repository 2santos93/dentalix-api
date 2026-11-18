import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ClinicRole, ExtraPermission } from '@prisma/client';
import {
  isLocationAllowed,
  locationNotAllowed,
  type AllowedLocations,
} from '../../../shared/tenancy/location-access';
import {
  checkPeriodDays,
  civilRangeInZone,
  PERIOD_DAY_OUT_OF_RANGE_MESSAGE,
} from '../../../shared/time/civil-day';
import {
  QUOTE_FOLLOW_UP_REPOSITORY,
  type QuoteFollowUpRepository,
} from '../domain/ports/quote-follow-up-repository.port';
import {
  buildFollowUpReport,
  FOLLOW_UP_REPORT_DEFINITIONS,
  type FollowUpReportDefinition,
  type FollowUpSkipCount,
  type FollowUpStepStats,
} from '../domain/quote-follow-up-report';

export const FOLLOW_UP_REPORT_MAX_DAYS = 366;
export const FOLLOW_UP_REPORT_INVALID_PERIOD_MESSAGE =
  'El período no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».';
export const FOLLOW_UP_REPORT_PERIOD_TOO_LONG_MESSAGE = `El período admite como mucho ${FOLLOW_UP_REPORT_MAX_DAYS} días.`;
export const FOLLOW_UP_REPORT_NO_TIME_ZONE_MESSAGE =
  'La sede no tiene zona horaria: configúrala en Ajustes › Sedes para ver el seguimiento.';

export interface FollowUpReportActor {
  userId: string;
  role: ClinicRole;
  permissions: readonly ExtraPermission[];
}

export interface FollowUpReportInput {
  from: string;
  to: string;
  locationId?: string;
  actor: FollowUpReportActor;
  allowedLocationIds: AllowedLocations;
}

export interface QuoteFollowUpReport {
  period: { from: string; to: string };
  /** CLINIC = todo lo visible; OWN = solo los presupuestos que elaboró quien consulta. */
  scope: 'CLINIC' | 'OWN';
  restrictedToLocations: boolean;
  filters: { locationId: string | null };
  steps: FollowUpStepStats[];
  total: FollowUpStepStats;
  skipped: FollowUpSkipCount[];
  definitions: readonly FollowUpReportDefinition[];
  options: { locations: { id: string; name: string }[] };
}

/**
 * Efectividad del seguimiento automático (DX-561, D5): por paso y en total,
 * enviados, abiertos y aceptados en los 14 días siguientes, y las omisiones
 * por motivo. Mismo alcance que el embudo de DX-558: ADMIN o quien tenga
 * FINANCIAL_REPORTS_VIEW ve toda la clínica; un DENTIST, solo los
 * presupuestos que elaboró (el plan raíz del grupo). Solo las sedes que ve.
 */
@Injectable()
export class GetQuoteFollowUpReportUseCase {
  constructor(
    @Inject(QUOTE_FOLLOW_UP_REPOSITORY)
    private readonly repo: QuoteFollowUpRepository,
  ) {}

  async execute(input: FollowUpReportInput): Promise<QuoteFollowUpReport> {
    const period = checkPeriodDays(input.from, input.to);
    if (!period.ok) {
      throw new BadRequestException(
        period.problem === 'OUT_OF_RANGE'
          ? PERIOD_DAY_OUT_OF_RANGE_MESSAGE
          : FOLLOW_UP_REPORT_INVALID_PERIOD_MESSAGE,
      );
    }
    if (period.days > FOLLOW_UP_REPORT_MAX_DAYS) {
      throw new BadRequestException(FOLLOW_UP_REPORT_PERIOD_TOO_LONG_MESSAGE);
    }
    const clinic =
      input.actor.role === ClinicRole.ADMIN ||
      input.actor.permissions.includes(ExtraPermission.FINANCIAL_REPORTS_VIEW);
    if (!clinic && input.actor.role !== ClinicRole.DENTIST) {
      throw new ForbiddenException(
        'Solo la administración, los odontólogos y quien tenga acceso a los reportes financieros ven el seguimiento de presupuestos.',
      );
    }
    const locations = await this.repo.reportLocations(input.allowedLocationIds);
    if (
      input.locationId !== undefined &&
      (!isLocationAllowed(input.allowedLocationIds, input.locationId) ||
        !locations.some((l) => l.id === input.locationId))
    ) {
      throw locationNotAllowed();
    }
    const selected = locations.filter(
      (l) => input.locationId === undefined || l.id === input.locationId,
    );
    if (input.locationId !== undefined && selected[0]?.timeZone === null) {
      throw new ConflictException(FOLLOW_UP_REPORT_NO_TIME_ZONE_MESSAGE);
    }
    // Sin zona no hay días civiles: una sede sin ella queda fuera de la
    // vista consolidada (no tiene ajustes que puedan enviar nada).
    const periods = selected
      .filter((l): l is typeof l & { timeZone: string } => l.timeZone !== null)
      .map((l) => {
        const range = civilRangeInZone(period.from, period.to, l.timeZone);
        return { locationId: l.id, from: range.start, to: range.end };
      });
    const rows = await this.repo.reportRows({
      periods,
      ...(clinic ? {} : { professionalId: input.actor.userId }),
    });
    return {
      period: { from: period.from, to: period.to },
      scope: clinic ? 'CLINIC' : 'OWN',
      restrictedToLocations: input.allowedLocationIds !== 'ALL',
      filters: { locationId: input.locationId ?? null },
      ...buildFollowUpReport(rows),
      definitions: FOLLOW_UP_REPORT_DEFINITIONS,
      options: {
        locations: locations.map((l) => ({ id: l.id, name: l.name })),
      },
    };
  }
}
