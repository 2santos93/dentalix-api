import { Inject, Injectable } from '@nestjs/common';
import {
  isLocationAllowed,
  locationNotAllowed,
  type AllowedLocations,
} from '../../../../shared/tenancy/location-access';
import type { CivilPeriod } from '../../domain/comparison-period';
import type { KpiDefinition } from '../../domain/kpi-definitions';
import {
  buildProductivity,
  PRODUCTIVITY_DEFINITIONS,
  PRODUCTIVITY_KPI_KEYS,
  type ProductivityFigures,
  type ProductivityRow,
  type ProfessionalSums,
} from '../../domain/professional-productivity';
import {
  PROFESSIONAL_REPORTS_REPOSITORY,
  type ProfessionalPeriodSums,
  type ProfessionalReportLocation,
  type ProfessionalReportOption,
  type ProfessionalReportScope,
  type ProfessionalReportsRepository,
} from '../../domain/ports/professional-reports-repository.port';
import {
  professionalReportPeriod,
  professionalScopeOf,
  type ProfessionalReportActor,
  type ProfessionalReportScopeKind,
} from '../professional-report-scope';

export const PRODUCTIVITY_FORBIDDEN_MESSAGE =
  'Solo la administración y los odontólogos ven la productividad por profesional.';
export const PRODUCTIVITY_OWN_ONLY_MESSAGE =
  'Solo puedes ver tu propia productividad.';

export interface ProfessionalReportInput {
  from: string;
  to: string;
  locationId?: string;
  professionalId?: string;
  actor: ProfessionalReportActor;
  /** Sedes del usuario (claim `loc`, DX-089). */
  allowedLocationIds: AllowedLocations;
}

export interface ProfessionalReportFilters {
  locationId: string | null;
  locationName: string | null;
  professionalId: string | null;
  professionalName: string | null;
}

export interface ProfessionalReportOptions {
  locations: ProfessionalReportLocation[];
  professionals: ProfessionalReportOption[];
}

export interface ProfessionalProductivity {
  from: string;
  to: string;
  scope: ProfessionalReportScopeKind;
  filters: ProfessionalReportFilters;
  options: ProfessionalReportOptions;
  rows: ProductivityRow[];
  totals: ProductivityFigures;
  definitions: KpiDefinition[];
  hasActivity: boolean;
}

export interface ResolvedProfessionalReport {
  period: CivilPeriod;
  kind: ProfessionalReportScopeKind;
  scope: ProfessionalReportScope;
  locations: ProfessionalReportLocation[];
}

/**
 * Período, alcance (DX-304: ADMIN/FINANCIAL_REPORTS_VIEW toda la clínica, el
 * DENTIST lo suyo) y sedes visibles. Una sede ajena a la clínica o no
 * permitida da el MISMO 403, para no decir qué sedes existen.
 */
export async function resolveProfessionalReport(
  repo: ProfessionalReportsRepository,
  input: ProfessionalReportInput,
  messages: { forbidden: string; ownOnly: string },
): Promise<ResolvedProfessionalReport> {
  const { professionalId, kind } = professionalScopeOf(
    input.actor,
    input.professionalId,
    messages,
  );
  const period = professionalReportPeriod(input.from, input.to);
  if (
    input.locationId !== undefined &&
    (!isLocationAllowed(input.allowedLocationIds, input.locationId) ||
      !(await repo.locationInClinic(input.locationId)))
  ) {
    throw locationNotAllowed();
  }
  const locations = await repo.listLocations(input.allowedLocationIds);
  const locationIds = locations
    .map((l) => l.id)
    .filter((id) => input.locationId === undefined || id === input.locationId);
  return {
    period,
    kind,
    locations,
    scope: {
      locationIds,
      ...(professionalId !== undefined ? { professionalId } : {}),
    },
  };
}

/** Filtros con nombre y opciones (a un DENTIST, solo él mismo). */
export async function professionalReportContext(
  repo: ProfessionalReportsRepository,
  resolved: ResolvedProfessionalReport,
  input: ProfessionalReportInput,
): Promise<{
  filters: ProfessionalReportFilters;
  options: ProfessionalReportOptions;
}> {
  const professionals = await repo.listProfessionals(
    resolved.locations.map((l) => l.id),
  );
  const visible =
    resolved.kind === 'OWN'
      ? professionals.filter((p) => p.userId === input.actor.userId)
      : professionals;
  const location = resolved.locations.find((l) => l.id === input.locationId);
  const professionalId = resolved.scope.professionalId;
  const professional = professionals.find((p) => p.userId === professionalId);
  return {
    filters: {
      locationId: location?.id ?? null,
      locationName: location?.name ?? null,
      professionalId: professionalId ?? null,
      professionalName: professional?.fullName ?? null,
    },
    options: { locations: resolved.locations, professionals: visible },
  };
}

interface MutableSums {
  professionalId: string;
  fullName: string | null;
  production: { currency: string; count: number; net: number }[];
  collected: { currency: string; amount: number }[];
  completed: number;
  noShow: number;
  lateCancellations: number;
}

/** Junta las tres sumas por profesional. */
export function sumsByProfessional(
  sums: ProfessionalPeriodSums,
): ProfessionalSums[] {
  const out = new Map<string, MutableSums>();
  const get = (id: string): MutableSums => {
    let row = out.get(id);
    if (!row) {
      row = {
        professionalId: id,
        fullName: sums.names.get(id) ?? null,
        production: [],
        collected: [],
        completed: 0,
        noShow: 0,
        lateCancellations: 0,
      };
      out.set(id, row);
    }
    return row;
  };
  for (const p of sums.production) {
    get(p.professionalId).production.push({
      currency: p.currency,
      count: p.count,
      net: p.net,
    });
  }
  for (const c of sums.collected) {
    get(c.professionalId).collected.push({
      currency: c.currency,
      amount: c.amount,
    });
  }
  for (const a of sums.attendance) {
    const row = get(a.professionalId);
    row.completed = a.completed;
    row.noShow = a.noShow;
    row.lateCancellations = a.lateCancellations;
  }
  return [...out.values()];
}

/**
 * «Profesionales» (DX-304): producción atribuible, cobrado atribuible, citas
 * atendidas y no-show % de cada profesional en el período, solo en las sedes
 * que ve quien consulta. Un DENTIST ve únicamente su fila (el filtro va en la
 * consulta: nunca llegan cifras de otros).
 */
@Injectable()
export class GetProfessionalProductivityUseCase {
  constructor(
    @Inject(PROFESSIONAL_REPORTS_REPOSITORY)
    private readonly repo: ProfessionalReportsRepository,
  ) {}

  async execute(
    input: ProfessionalReportInput,
  ): Promise<ProfessionalProductivity> {
    const resolved = await resolveProfessionalReport(this.repo, input, {
      forbidden: PRODUCTIVITY_FORBIDDEN_MESSAGE,
      ownOnly: PRODUCTIVITY_OWN_ONLY_MESSAGE,
    });
    const [sums, context] = await Promise.all([
      this.repo.sums(resolved.period, resolved.scope),
      professionalReportContext(this.repo, resolved, input),
    ]);
    const { rows, totals } = buildProductivity(sumsByProfessional(sums));
    return {
      from: resolved.period.from,
      to: resolved.period.to,
      scope: resolved.kind,
      ...context,
      rows,
      totals,
      definitions: PRODUCTIVITY_KPI_KEYS.map(
        (key) => PRODUCTIVITY_DEFINITIONS[key],
      ),
      hasActivity: rows.length > 0,
    };
  }
}
