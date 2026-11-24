import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  isLocationAllowed,
  locationNotAllowed,
  type AllowedLocations,
} from '../../../../shared/tenancy/location-access';
import {
  checkPeriodDays,
  PERIOD_DAY_OUT_OF_RANGE_MESSAGE,
} from '../../../../shared/time/civil-day';
import { addCivilMonths } from '../../../recall/domain/recall-rules';
import type { CivilPeriod } from '../../domain/comparison-period';
import {
  addFacts,
  EMPTY_RETENTION_COUNTS,
  retentionBounds,
  retentionDefinitions,
  RETENTION_DEFAULT_ACTIVE_MONTHS,
  withRate,
  type RetentionActiveMonths,
  type RetentionDefinition,
  type RetentionFigures,
  type RetentionSegment,
} from '../../domain/retention';
import {
  RETENTION_REPOSITORY,
  type RetentionLocation,
  type RetentionPatientRow,
  type RetentionProfessionalOption,
  type RetentionQuery,
  type RetentionRepository,
} from '../../domain/ports/retention-repository.port';
import {
  phoneRegionOrNull,
  whatsAppDigits,
} from '../../../../shared/phone/phone-number';

export const RETENTION_FORBIDDEN_MESSAGE =
  'Solo la administración y quien tenga acceso a los reportes financieros ven la retención de pacientes.';
export const RETENTION_CSV_FORBIDDEN_MESSAGE =
  'Solo la administración descarga las listas de retención: llevan nombres y teléfonos de pacientes.';
export const RETENTION_INVALID_PERIOD_MESSAGE =
  'El período no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».';
/** Con más de 12 meses, «nuevos» y «recuperados» podrían no seguir activos al final. */
export const RETENTION_MAX_MONTHS = 12;
export const RETENTION_PERIOD_TOO_LONG_MESSAGE =
  'El período admite como mucho 12 meses.';
export const RETENTION_LOCATION_NOT_FOUND_MESSAGE = 'Sede no encontrada.';

export const RETENTION_PAGE_SIZE = 25;
/** Tope de filas del CSV de una lista. */
export const RETENTION_CSV_MAX_ROWS = 10_000;

export interface RetentionInput {
  from: string;
  to: string;
  locationId?: string;
  providerId?: string;
  activeMonths?: RetentionActiveMonths;
  /** Sedes del usuario (claim `loc`, DX-089). */
  allowedLocationIds: AllowedLocations;
}

export interface RetentionFilters {
  locationId: string | null;
  locationName: string | null;
  providerId: string | null;
  providerName: string | null;
  activeMonths: RetentionActiveMonths;
}

export interface RetentionOptions {
  locations: RetentionLocation[];
  professionals: RetentionProfessionalOption[];
}

export interface RetentionRow extends RetentionFigures {
  locationId: string;
  locationName: string;
  providerId: string;
  providerName: string;
}

export interface RetentionLocationTotal extends RetentionFigures {
  locationId: string;
  locationName: string;
}

export interface RetentionReport {
  from: string;
  to: string;
  filters: RetentionFilters;
  options: RetentionOptions;
  /** Una fila por sede y profesional con algún paciente en alguna cifra. */
  rows: RetentionRow[];
  /** Subtotal por sede (las sedes con filas). */
  locations: RetentionLocationTotal[];
  totals: RetentionFigures;
  definitions: RetentionDefinition[];
  /** false = «Sin datos en el periodo» (ninguna cifra con pacientes). */
  hasData: boolean;
}

export interface RetentionPatientsInput extends RetentionInput {
  segment: RetentionSegment;
  page?: number;
  pageSize?: number;
}

export interface RetentionPatientItem extends Omit<
  RetentionPatientRow,
  'phoneRegion' | 'providerName'
> {
  providerName: string;
  /** E.164 sin `+` para `https://wa.me/…`; null si no sirve o hay baja de avisos. */
  whatsApp: string | null;
  /** Zona de la sede (para pintar las fechas). */
  timeZone: string;
}

export interface RetentionPatientsReport {
  from: string;
  to: string;
  segment: RetentionSegment;
  filters: RetentionFilters;
  definition: RetentionDefinition;
  items: RetentionPatientItem[];
  total: number;
  page: number;
  pageSize: number;
  /** Solo en el CSV: había más filas que el tope. */
  truncated: boolean;
}

export const UNNAMED_PROFESSIONAL = 'Profesional sin nombre';

/** El «ahora» de la cita futura agendada (inyectable en los tests). */
export const RETENTION_CLOCK = Symbol('RETENTION_CLOCK');
export type RetentionClock = () => Date;

interface Resolved {
  period: CivilPeriod;
  activeMonths: RetentionActiveMonths;
  locations: RetentionLocation[];
  query: RetentionQuery;
  zones: ReadonlyMap<string, string>;
}

/** El período: fechas válidas y como mucho 12 meses por calendario. */
export function retentionPeriod(from: string, to: string): CivilPeriod {
  const period = checkPeriodDays(from, to);
  if (!period.ok) {
    throw new BadRequestException(
      period.problem === 'OUT_OF_RANGE'
        ? PERIOD_DAY_OUT_OF_RANGE_MESSAGE
        : RETENTION_INVALID_PERIOD_MESSAGE,
    );
  }
  if (period.to >= addCivilMonths(period.from, RETENTION_MAX_MONTHS)) {
    throw new BadRequestException(RETENTION_PERIOD_TOO_LONG_MESSAGE);
  }
  return { from: period.from, to: period.to };
}

/**
 * «Retención» (DX-260): activos al inicio, nuevos, perdidos, activos al
 * final, recuperados, retención y nuevos sin regreso por sede y profesional
 * (los de la última cita atendida de cada paciente), con las definiciones
 * de `domain/retention.ts`, y la lista de pacientes de cada cifra.
 *
 * Una sede que no es de la clínica (o retirada) es 404; una de la clínica
 * fuera de las del usuario (DX-089), el 403 de siempre.
 */
@Injectable()
export class GetRetentionUseCase {
  constructor(
    @Inject(RETENTION_REPOSITORY)
    private readonly repo: RetentionRepository,
    @Inject(RETENTION_CLOCK) private readonly clock: RetentionClock,
  ) {}

  private async resolve(input: RetentionInput): Promise<Resolved> {
    const period = retentionPeriod(input.from, input.to);
    const activeMonths = input.activeMonths ?? RETENTION_DEFAULT_ACTIVE_MONTHS;
    if (input.locationId !== undefined) {
      if (!(await this.repo.locationInClinic(input.locationId))) {
        throw new NotFoundException(RETENTION_LOCATION_NOT_FOUND_MESSAGE);
      }
      if (!isLocationAllowed(input.allowedLocationIds, input.locationId)) {
        throw locationNotAllowed();
      }
    }
    const [locations, zones] = await Promise.all([
      this.repo.listLocations(input.allowedLocationIds),
      this.repo.locationZones(),
    ]);
    const locationIds = locations
      .map((l) => l.id)
      .filter(
        (id) => input.locationId === undefined || id === input.locationId,
      );
    const bounds = [...zones].map(([locationId, zone]) => ({
      locationId,
      ...retentionBounds(period, activeMonths, zone),
    }));
    return {
      period,
      activeMonths,
      locations,
      zones,
      query: {
        bounds,
        locationIds,
        ...(input.providerId !== undefined
          ? { providerId: input.providerId }
          : {}),
        now: this.clock(),
      },
    };
  }

  private filters(
    resolved: Resolved,
    input: RetentionInput,
    professionals: readonly RetentionProfessionalOption[],
    providerName?: string | null,
  ): RetentionFilters {
    const location = resolved.locations.find((l) => l.id === input.locationId);
    const professional = professionals.find(
      (p) => p.userId === input.providerId,
    );
    return {
      locationId: location?.id ?? null,
      locationName: location?.name ?? null,
      providerId: input.providerId ?? null,
      providerName: professional?.fullName ?? providerName ?? null,
      activeMonths: resolved.activeMonths,
    };
  }

  async execute(input: RetentionInput): Promise<RetentionReport> {
    const resolved = await this.resolve(input);
    const [groups, professionals] = await Promise.all([
      this.repo.factGroups(resolved.query),
      this.repo.listProfessionals(resolved.locations.map((l) => l.id)),
    ]);

    const rows = new Map<string, RetentionRow>();
    const byLocation = new Map<string, RetentionLocationTotal>();
    const totals = { ...EMPTY_RETENTION_COUNTS };
    for (const g of groups) {
      const key = `${g.locationId}|${g.providerId}`;
      const row = rows.get(key) ?? {
        locationId: g.locationId,
        locationName: g.locationName,
        providerId: g.providerId,
        providerName: g.providerName ?? UNNAMED_PROFESSIONAL,
        ...EMPTY_RETENTION_COUNTS,
        retentionRate: null,
      };
      addFacts(row, g.facts, g.count);
      rows.set(key, row);
      const loc = byLocation.get(g.locationId) ?? {
        locationId: g.locationId,
        locationName: g.locationName,
        ...EMPTY_RETENTION_COUNTS,
        retentionRate: null,
      };
      addFacts(loc, g.facts, g.count);
      byLocation.set(g.locationId, loc);
      addFacts(totals, g.facts, g.count);
    }
    const order = new Map(resolved.locations.map((l, i) => [l.id, i]));
    const byPlace = (a: { locationId: string }, b: { locationId: string }) =>
      (order.get(a.locationId) ?? 0) - (order.get(b.locationId) ?? 0);
    const finalRows = [...rows.values()]
      .map((r) => ({ ...r, ...withRate(r) }))
      .filter((r) => hasAny(r))
      .sort(
        (a, b) =>
          byPlace(a, b) ||
          a.providerName.localeCompare(b.providerName, 'es', {
            sensitivity: 'base',
          }) ||
          a.providerId.localeCompare(b.providerId),
      );
    const finalTotals = withRate(totals);
    return {
      from: resolved.period.from,
      to: resolved.period.to,
      filters: this.filters(resolved, input, professionals),
      options: { locations: resolved.locations, professionals },
      rows: finalRows,
      locations: [...byLocation.values()]
        .map((l) => ({ ...l, ...withRate(l) }))
        .filter((l) => hasAny(l))
        .sort(byPlace),
      totals: finalTotals,
      definitions: retentionDefinitions(resolved.activeMonths),
      hasData: hasAny(finalTotals),
    };
  }

  async patients(
    input: RetentionPatientsInput,
  ): Promise<RetentionPatientsReport> {
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? RETENTION_PAGE_SIZE;
    return this.list(input, { skip: (page - 1) * pageSize, take: pageSize });
  }

  /** Todas las filas (hasta el tope) para el CSV. */
  async exportPatients(
    input: RetentionPatientsInput,
  ): Promise<RetentionPatientsReport> {
    return this.list(input, { skip: 0, take: RETENTION_CSV_MAX_ROWS });
  }

  private async list(
    input: RetentionPatientsInput,
    paging: { skip: number; take: number },
  ): Promise<RetentionPatientsReport> {
    const resolved = await this.resolve(input);
    const [result, professionals] = await Promise.all([
      this.repo.listPatients(resolved.query, input.segment, paging),
      this.repo.listProfessionals(resolved.locations.map((l) => l.id)),
    ]);
    const definition = retentionDefinitions(resolved.activeMonths).find(
      (d) => d.segment === input.segment,
    )!;
    return {
      from: resolved.period.from,
      to: resolved.period.to,
      segment: input.segment,
      filters: this.filters(resolved, input, professionals),
      definition,
      items: result.items.map((r) => toItem(r, resolved.zones)),
      total: result.total,
      page: Math.floor(paging.skip / paging.take) + 1,
      pageSize: paging.take,
      truncated: result.total > paging.skip + result.items.length,
    };
  }
}

function hasAny(f: RetentionFigures): boolean {
  return (
    f.activeAtStart +
      f.newPatients +
      f.lost +
      f.activeAtEnd +
      f.reactivated +
      f.newNoReturn >
    0
  );
}

function toItem(
  r: RetentionPatientRow,
  zones: ReadonlyMap<string, string>,
): RetentionPatientItem {
  const { phoneRegion, providerName, ...rest } = r;
  return {
    ...rest,
    providerName: providerName ?? UNNAMED_PROFESSIONAL,
    // DX-128: con baja de avisos cuenta en la cifra, pero sin wa.me.
    whatsApp: r.reminderOptedOut
      ? null
      : whatsAppDigits(r.phone, phoneRegionOrNull(phoneRegion)),
    // La sede atribuida siempre tiene zona: sus citas solo entran con ella.
    timeZone: zones.get(r.locationId) ?? '',
  };
}
