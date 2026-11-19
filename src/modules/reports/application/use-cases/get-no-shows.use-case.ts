import { Inject, Injectable } from '@nestjs/common';
import {
  KPI_DEFINITIONS,
  noShowRateOf,
  type KpiDefinition,
} from '../../domain/kpi-definitions';
import {
  PROFESSIONAL_REPORTS_REPOSITORY,
  type MissedAppointmentRow,
  type ProfessionalReportsRepository,
} from '../../domain/ports/professional-reports-repository.port';
import type { ProfessionalReportScopeKind } from '../professional-report-scope';
import {
  professionalReportContext,
  resolveProfessionalReport,
  type ProfessionalReportFilters,
  type ProfessionalReportInput,
  type ProfessionalReportOptions,
} from './get-professional-productivity.use-case';

export const NO_SHOWS_FORBIDDEN_MESSAGE =
  'Solo la administración y los odontólogos ven las inasistencias.';
export const NO_SHOWS_OWN_ONLY_MESSAGE =
  'Solo puedes ver las inasistencias de tu agenda.';

export const NO_SHOWS_PAGE_SIZE = 25;
/** Tope de filas del CSV: un período de 24 meses de una clínica grande. */
export const NO_SHOWS_CSV_MAX_ROWS = 10_000;

export interface NoShowsInput extends ProfessionalReportInput {
  page?: number;
  pageSize?: number;
}

export interface NoShowsSummary {
  completedAppointments: number;
  noShows: number;
  lateCancellations: number;
  /** % con la definición de `kpi-definitions`; null sin citas que cuenten. */
  noShowRate: number | null;
}

export interface NoShowsReport {
  from: string;
  to: string;
  scope: ProfessionalReportScopeKind;
  filters: ProfessionalReportFilters;
  options: ProfessionalReportOptions;
  summary: NoShowsSummary;
  definition: KpiDefinition;
  items: MissedAppointmentRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Solo en el CSV: había más filas que el tope. */
  truncated: boolean;
}

/**
 * «Inasistencias» (DX-304): el no-show % del período con la definición de
 * `kpi-definitions` (no asistió ÷ atendidas + no asistió + tardías) y la
 * lista de las citas no asistidas y canceladas tarde (DX-279), de la más
 * reciente a la más antigua. Mismo alcance que «Profesionales»: el DENTIST,
 * solo las de su agenda.
 */
@Injectable()
export class GetNoShowsUseCase {
  constructor(
    @Inject(PROFESSIONAL_REPORTS_REPOSITORY)
    private readonly repo: ProfessionalReportsRepository,
  ) {}

  async execute(input: NoShowsInput): Promise<NoShowsReport> {
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? NO_SHOWS_PAGE_SIZE;
    return this.report(input, { skip: (page - 1) * pageSize, take: pageSize });
  }

  /** Todas las filas (hasta el tope) para el CSV. */
  async exportAll(input: ProfessionalReportInput): Promise<NoShowsReport> {
    return this.report(input, { skip: 0, take: NO_SHOWS_CSV_MAX_ROWS });
  }

  private async report(
    input: ProfessionalReportInput,
    paging: { skip: number; take: number },
  ): Promise<NoShowsReport> {
    const resolved = await resolveProfessionalReport(this.repo, input, {
      forbidden: NO_SHOWS_FORBIDDEN_MESSAGE,
      ownOnly: NO_SHOWS_OWN_ONLY_MESSAGE,
    });
    const [attendance, missed, context] = await Promise.all([
      this.repo.attendance(resolved.period, resolved.scope),
      this.repo.listMissed(resolved.period, resolved.scope, paging),
      professionalReportContext(this.repo, resolved, input),
    ]);
    const counts = {
      completed: attendance.reduce((n, a) => n + a.completed, 0),
      noShow: attendance.reduce((n, a) => n + a.noShow, 0),
      lateCancellations: attendance.reduce(
        (n, a) => n + a.lateCancellations,
        0,
      ),
    };
    return {
      from: resolved.period.from,
      to: resolved.period.to,
      scope: resolved.kind,
      ...context,
      summary: {
        completedAppointments: counts.completed,
        noShows: counts.noShow,
        lateCancellations: counts.lateCancellations,
        noShowRate: noShowRateOf(counts),
      },
      definition: KPI_DEFINITIONS.noShowRate,
      items: missed.items,
      total: missed.total,
      page: Math.floor(paging.skip / paging.take) + 1,
      pageSize: paging.take,
      truncated: missed.total > paging.skip + missed.items.length,
    };
  }
}
