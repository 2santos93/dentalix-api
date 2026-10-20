import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ClinicRole } from '@prisma/client';
import {
  LOCATION_REPOSITORY,
  type Location,
  type LocationRepository,
} from '../../../locations/domain/ports/location-repository.port';
import {
  STAFF_REPOSITORY,
  type StaffRepository,
} from '../../../staff/domain/ports/staff-repository.port';
import type { StaffMember } from '../../../staff/domain/entities/staff-member.entity';
import { attendsAt } from '../../../staff/domain/provider-location';
import { ATTENDING_ROLES } from '../../../schedule-blocks/domain/schedule-block-rules';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { isLocationAllowed } from '../../../../shared/tenancy/location-access';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { AuditScheduleEntry } from '../../../audit/domain/audit-metadata';
import {
  addCivilDays,
  civilDateIn,
  civilDaysInclusive,
  civilWeekday,
  parseCivilDate,
} from '../../../../shared/time/civil-day';
import {
  PROVIDER_SCHEDULE_REPOSITORY,
  type ProviderScheduleRepository,
} from '../../domain/ports/provider-schedule-repository.port';
import {
  OVERRIDE_WINDOW_DAYS,
  crossLocationConflictOn,
  crossLocationMessage,
  overrideRangesError,
  providerDayAssignments,
  providerRangesOn,
  weeklyScheduleError,
  type DaySource,
  type MinuteRange,
  type ProviderOverride,
  type ProviderScheduleSnapshot,
  type WeeklyLocationInput,
  type WeeklyProviderRange,
} from '../../domain/provider-availability';

/** Reloj del horario (qué día es hoy en la sede); los tests lo fijan. */
export const PROVIDER_SCHEDULE_CLOCK = Symbol('PROVIDER_SCHEDULE_CLOCK');
export type ProviderScheduleClock = () => Date;

export const PROVIDER_NOT_FOUND_MESSAGE = 'Profesional no encontrado';
export const PROVIDER_NOT_ATTENDING_MESSAGE =
  'Ese miembro del equipo no atiende pacientes: no tiene horario que configurar.';
export const OVERRIDE_NOT_FOUND_MESSAGE = 'Excepción no encontrada';
export const CIVIL_DATE_MESSAGE =
  'Las fechas tienen que ser días reales en formato AAAA-MM-DD';
/**
 * DX-089: un profesional acotado a ciertas sedes (`membership_locations`) no
 * puede tener horario ni excepciones en las demás: allí no se le puede citar.
 */
export function providerLocationNotAllowedMessage(
  providerName: string,
  locationName: string,
): string {
  return `${providerName} no atiende en ${locationName}: solo se le puede poner horario en las sedes que tiene permitidas en Personal.`;
}
/** Días máximos del cuadrante en una petición. */
export const MAX_ROSTER_DAYS = 31;

// ---------------------------------------------------------------------------
// Vistas
// ---------------------------------------------------------------------------

export interface WeeklyRangeView {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export interface ProviderLocationScheduleView {
  locationId: string;
  locationName: string;
  timeZone: string;
  ranges: WeeklyRangeView[];
}

export interface ProviderScheduleView {
  providerId: string;
  /** false = sin horario: se le puede citar en cualquier horario de la sede. */
  configured: boolean;
  locations: ProviderLocationScheduleView[];
}

export interface ProviderOverrideView extends ProviderOverride {
  providerId: string;
  locationName: string;
  /** Sin tramos = «no trabaja» ese día en esa sede. */
  off: boolean;
}

export interface RosterAssignmentView {
  locationId: string;
  source: DaySource;
  overrideId: string | null;
  /** Vacío = excepción «no trabaja» en esa sede. */
  ranges: MinuteRange[];
}

export interface RosterDayView {
  date: string;
  weekday: number;
  /** Sin horario y sin excepción ese día: sin restricción en ninguna sede. */
  unrestricted: boolean;
  assignments: RosterAssignmentView[];
  /** Solo con `locationId`: ¿trabaja ese día en la sede pedida? */
  worksAtLocation: boolean | null;
  /**
   * Solo con `locationId`: sus tramos en la sede ese día (vacío = no trabaja
   * allí; `null` = sin restricción o sin `locationId`). Lo que la agenda
   * sombrea es el complemento.
   */
  locationRanges: MinuteRange[] | null;
}

export interface RosterProviderView {
  providerId: string;
  fullName: string;
  role: ClinicRole;
  configured: boolean;
  days: RosterDayView[];
}

export interface RosterView {
  from: string;
  to: string;
  locationId: string | null;
  locations: { id: string; name: string; timeZone: string }[];
  providers: RosterProviderView[];
}

export interface ProviderScheduleSettings {
  strictProviderSchedule: boolean;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

async function requireAttendingProvider(
  staff: StaffRepository,
  providerId: string,
): Promise<StaffMember> {
  const member = await staff.findById(providerId);
  if (!member) throw new NotFoundException(PROVIDER_NOT_FOUND_MESSAGE);
  if (!ATTENDING_ROLES.includes(member.role)) {
    throw new BadRequestException(PROVIDER_NOT_ATTENDING_MESSAGE);
  }
  return member;
}

/** 400 si el profesional está acotado a sedes y esta no es una de ellas. */
function assertProviderAttendsAt(
  member: StaffMember,
  location: Pick<Location, 'id' | 'name'>,
): void {
  if (!attendsAt(member, location.id)) {
    throw new BadRequestException(
      providerLocationNotAllowedMessage(member.fullName, location.name),
    );
  }
}

/**
 * DX-089: lo que LEE un miembro acotado se limita a sus sedes permitidas,
 * como `GET /locations` (sin restricción, todas).
 */
function visibleLocation(
  tenantContext: TenantContextService,
): (locationId: string) => boolean {
  const allowed = tenantContext.getAllowedLocationIds();
  return (locationId) => isLocationAllowed(allowed, locationId);
}

/** Sedes de la clínica por id (bajo RLS: una ajena no está). */
async function locationsById(
  locations: LocationRepository,
): Promise<Map<string, Location>> {
  return new Map((await locations.list()).map((l) => [l.id, l]));
}

function requireCivilDate(value: string): string {
  if (parseCivilDate(value) === null) {
    throw new BadRequestException(CIVIL_DATE_MESSAGE);
  }
  return value;
}

function weeklyAudit(ranges: readonly WeeklyProviderRange[]) {
  return ranges.map((r): AuditScheduleEntry => ({
    locationId: r.locationId,
    weekday: r.weekday,
    startMinute: r.startMinute,
    endMinute: r.endMinute,
  }));
}

function overrideAudit(o: ProviderOverride | null): AuditScheduleEntry[] {
  if (!o) return [];
  if (o.ranges.length === 0) {
    return [{ locationId: o.locationId, date: o.date, off: true }];
  }
  return o.ranges.map((r) => ({
    locationId: o.locationId,
    date: o.date,
    startMinute: r.startMinute,
    endMinute: r.endMinute,
  }));
}

function toView(
  providerId: string,
  snapshot: ProviderScheduleSnapshot,
  byId: Map<string, Location>,
): ProviderScheduleView {
  const ids = [...new Set(snapshot.weekly.map((r) => r.locationId))];
  return {
    providerId,
    configured: snapshot.configured,
    locations: ids.map((locationId) => {
      const location = byId.get(locationId);
      return {
        locationId,
        locationName: location?.name ?? '',
        timeZone: location?.timeZone ?? '',
        ranges: snapshot.weekly
          .filter((r) => r.locationId === locationId)
          .map(({ weekday, startMinute, endMinute }) => ({
            weekday,
            startMinute,
            endMinute,
          })),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Horario semanal
// ---------------------------------------------------------------------------

/** GET /providers/:providerId/schedule */
@Injectable()
export class GetProviderScheduleUseCase {
  constructor(
    @Inject(PROVIDER_SCHEDULE_REPOSITORY)
    private readonly repo: ProviderScheduleRepository,
    @Inject(STAFF_REPOSITORY) private readonly staff: StaffRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    @Inject(PROVIDER_SCHEDULE_CLOCK)
    private readonly clock: ProviderScheduleClock,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(providerId: string): Promise<ProviderScheduleView> {
    await requireAttendingProvider(this.staff, providerId);
    const today = civilDateIn(this.clock(), 'UTC');
    const snapshot = (
      await this.repo.findSnapshots([providerId], { from: today, to: today })
    ).get(providerId)!;
    // `configured` es del profesional; las sedes, solo las que ve el lector.
    const visible = visibleLocation(this.tenantContext);
    return toView(
      providerId,
      {
        ...snapshot,
        weekly: snapshot.weekly.filter((r) => visible(r.locationId)),
      },
      await locationsById(this.locations),
    );
  }
}

export interface ReplaceProviderScheduleInput {
  locations: WeeklyLocationInput[];
}

/** PUT /providers/:providerId/schedule — todas sus sedes en un cuerpo. */
@Injectable()
export class ReplaceProviderScheduleUseCase {
  constructor(
    @Inject(PROVIDER_SCHEDULE_REPOSITORY)
    private readonly repo: ProviderScheduleRepository,
    @Inject(STAFF_REPOSITORY) private readonly staff: StaffRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    private readonly audit: RecordAuditEventUseCase,
    @Inject(PROVIDER_SCHEDULE_CLOCK)
    private readonly clock: ProviderScheduleClock,
  ) {}

  async execute(
    providerId: string,
    input: ReplaceProviderScheduleInput,
    ctx: AuditRequestContext,
  ): Promise<ProviderScheduleView> {
    const member = await requireAttendingProvider(this.staff, providerId);
    const byId = await locationsById(this.locations);
    for (const loc of input.locations) {
      const location = byId.get(loc.locationId);
      if (!location) throw new BadRequestException('Sede no encontrada');
      // Quitarle una sede (sin tramos) siempre se puede.
      if (loc.ranges.length > 0) assertProviderAttendsAt(member, location);
      if (!location.isActive && loc.ranges.length > 0) {
        throw new BadRequestException(
          `La sede ${location.name} está desactivada: no se le puede poner horario.`,
        );
      }
    }
    const nameOf = (id: string) => byId.get(id)?.name ?? id;
    const error = weeklyScheduleError(input.locations, nameOf);
    if (error) throw new BadRequestException(error);

    // Una sede sin tramos es «no trabaja allí»: no se guarda fila.
    const kept = input.locations.filter((l) => l.ranges.length > 0);
    const newWeekly: WeeklyProviderRange[] = kept.flatMap((l) =>
      l.ranges.map((r) => ({ locationId: l.locationId, ...r })),
    );
    // Las excepciones de hoy en adelante (en cualquier zona) siguen mandando
    // su día: el semanal nuevo no puede pisarlas desde otra sede.
    const overridesFrom = addCivilDays(civilDateIn(this.clock(), 'UTC'), -1);

    const change = await this.repo.replaceWeekly({
      providerId,
      actorId: ctx.actor.userId,
      overridesFrom,
      locations: kept.map((l) => ({
        locationId: l.locationId,
        timezone: byId.get(l.locationId)!.timeZone,
        ranges: l.ranges,
      })),
      validate: (current) => {
        const next: ProviderScheduleSnapshot = {
          ...current,
          configured: kept.length > 0,
          weekly: newWeekly,
        };
        for (const o of current.overrides) {
          const conflict = crossLocationConflictOn(
            next,
            o.locationId,
            o.date,
            o.ranges,
          );
          if (conflict) {
            throw new BadRequestException(
              crossLocationMessage(
                `el ${o.date}`,
                {
                  name: `${nameOf(o.locationId)} (excepción)`,
                  range: conflict.mine,
                },
                {
                  name: nameOf(conflict.otherLocationId),
                  range: conflict.theirs,
                },
              ),
            );
          }
        }
      },
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action: 'UPDATE',
      resourceType: 'PROVIDER_SCHEDULE',
      resourceId: providerId,
      patient: null,
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: {
        reason: 'PROVIDER_SCHEDULE_REPLACED',
        scheduleChange: {
          before: weeklyAudit(change.before),
          after: weeklyAudit(change.after),
        },
      },
    });

    return toView(
      providerId,
      {
        providerId,
        configured: change.after.length > 0,
        weekly: change.after,
        overrides: [],
      },
      byId,
    );
  }
}

// ---------------------------------------------------------------------------
// Excepciones por fecha
// ---------------------------------------------------------------------------

function overrideView(
  providerId: string,
  o: ProviderOverride,
  byId: Map<string, Location>,
): ProviderOverrideView {
  return {
    ...o,
    providerId,
    locationName: byId.get(o.locationId)?.name ?? '',
    off: o.ranges.length === 0,
  };
}

export interface ListOverridesInput {
  from?: string;
  to?: string;
}

/** GET /providers/:providerId/schedule-overrides */
@Injectable()
export class ListProviderOverridesUseCase {
  constructor(
    @Inject(PROVIDER_SCHEDULE_REPOSITORY)
    private readonly repo: ProviderScheduleRepository,
    @Inject(STAFF_REPOSITORY) private readonly staff: StaffRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    @Inject(PROVIDER_SCHEDULE_CLOCK)
    private readonly clock: ProviderScheduleClock,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(
    providerId: string,
    input: ListOverridesInput,
  ): Promise<ProviderOverrideView[]> {
    await requireAttendingProvider(this.staff, providerId);
    const from = input.from
      ? requireCivilDate(input.from)
      : addCivilDays(civilDateIn(this.clock(), 'UTC'), -1);
    const to = input.to
      ? requireCivilDate(input.to)
      : addCivilDays(from, OVERRIDE_WINDOW_DAYS + 1);
    const days = civilDaysInclusive(from, to);
    if (days < 1) {
      throw new BadRequestException(
        'La fecha final no puede ser anterior a la inicial',
      );
    }
    if (days > OVERRIDE_WINDOW_DAYS + 2) {
      throw new BadRequestException(
        'Consulta como mucho dos años de excepciones a la vez',
      );
    }
    const byId = await locationsById(this.locations);
    const rows = await this.repo.listOverrides(providerId, { from, to });
    const visible = visibleLocation(this.tenantContext);
    return rows
      .filter((o) => visible(o.locationId))
      .map((o) => overrideView(providerId, o, byId));
  }
}

export interface SetOverrideInput {
  locationId: string;
  date: string;
  ranges: MinuteRange[];
  note?: string | null;
}

/**
 * POST /providers/:providerId/schedule-overrides — crea la excepción de esa
 * sede y fecha, o reemplaza la que hubiera (una viva por sede y fecha).
 */
@Injectable()
export class SetProviderOverrideUseCase {
  constructor(
    @Inject(PROVIDER_SCHEDULE_REPOSITORY)
    private readonly repo: ProviderScheduleRepository,
    @Inject(STAFF_REPOSITORY) private readonly staff: StaffRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    private readonly audit: RecordAuditEventUseCase,
    @Inject(PROVIDER_SCHEDULE_CLOCK)
    private readonly clock: ProviderScheduleClock,
  ) {}

  async execute(
    providerId: string,
    input: SetOverrideInput,
    ctx: AuditRequestContext,
  ): Promise<ProviderOverrideView & { replaced: boolean }> {
    const member = await requireAttendingProvider(this.staff, providerId);
    const byId = await locationsById(this.locations);
    const location = byId.get(input.locationId);
    if (!location) throw new BadRequestException('Sede no encontrada');
    assertProviderAttendsAt(member, location);
    const date = requireCivilDate(input.date);
    const today = civilDateIn(this.clock(), location.timeZone);
    if (date < today) {
      throw new BadRequestException(
        'La excepción no puede ser de un día que ya pasó en la sede',
      );
    }
    if (date > addCivilDays(today, OVERRIDE_WINDOW_DAYS)) {
      throw new BadRequestException(
        'La excepción tiene que ser de los próximos dos años',
      );
    }
    const note = input.note?.trim() || null;
    if (note && note.length > 200) {
      throw new BadRequestException('La nota admite hasta 200 caracteres');
    }
    const error = overrideRangesError(input.ranges);
    if (error) throw new BadRequestException(error);
    const ranges = [...input.ranges].sort(
      (a, b) => a.startMinute - b.startMinute,
    );
    const nameOf = (id: string) => byId.get(id)?.name ?? id;

    const change = await this.repo.upsertOverride({
      providerId,
      locationId: input.locationId,
      date,
      ranges,
      note,
      actorId: ctx.actor.userId,
      validate: (current) => {
        const conflict = crossLocationConflictOn(
          current,
          input.locationId,
          date,
          ranges,
        );
        if (conflict) {
          throw new BadRequestException(
            crossLocationMessage(
              `el ${date}`,
              { name: nameOf(input.locationId), range: conflict.mine },
              {
                name: nameOf(conflict.otherLocationId),
                range: conflict.theirs,
              },
            ),
          );
        }
      },
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action: change.before ? 'UPDATE' : 'CREATE',
      resourceType: 'PROVIDER_SCHEDULE',
      resourceId: providerId,
      patient: null,
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: {
        reason: 'PROVIDER_SCHEDULE_OVERRIDE_SET',
        params: { overrideId: change.after.id },
        scheduleChange: {
          before: overrideAudit(change.before),
          after: overrideAudit(change.after),
        },
      },
    });
    return {
      ...overrideView(providerId, change.after, byId),
      replaced: change.before !== null,
    };
  }
}

/** DELETE /providers/:providerId/schedule-overrides/:overrideId */
@Injectable()
export class DeleteProviderOverrideUseCase {
  constructor(
    @Inject(PROVIDER_SCHEDULE_REPOSITORY)
    private readonly repo: ProviderScheduleRepository,
    @Inject(STAFF_REPOSITORY) private readonly staff: StaffRepository,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  async execute(
    providerId: string,
    overrideId: string,
    ctx: AuditRequestContext,
  ): Promise<void> {
    await requireAttendingProvider(this.staff, providerId);
    const removed = await this.repo.deleteOverride(providerId, overrideId);
    if (!removed) throw new NotFoundException(OVERRIDE_NOT_FOUND_MESSAGE);
    await this.audit.record({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action: 'DELETE',
      resourceType: 'PROVIDER_SCHEDULE',
      resourceId: providerId,
      patient: null,
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: {
        reason: 'PROVIDER_SCHEDULE_OVERRIDE_DELETED',
        params: { overrideId },
        scheduleChange: { before: overrideAudit(removed), after: [] },
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Cuadrante
// ---------------------------------------------------------------------------

export interface RosterInput {
  weekStart: string;
  days?: number;
  locationId?: string;
}

/**
 * GET /schedule/roster — profesional × día con la sede (o sedes) y los
 * tramos; con `locationId`, además si trabaja allí y sus tramos en esa sede
 * (lo que la agenda necesita para sombrear y ocultar columnas).
 */
@Injectable()
export class GetScheduleRosterUseCase {
  constructor(
    @Inject(PROVIDER_SCHEDULE_REPOSITORY)
    private readonly repo: ProviderScheduleRepository,
    @Inject(STAFF_REPOSITORY) private readonly staff: StaffRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(input: RosterInput): Promise<RosterView> {
    const from = requireCivilDate(input.weekStart);
    const days = input.days ?? 7;
    if (!Number.isInteger(days) || days < 1 || days > MAX_ROSTER_DAYS) {
      throw new BadRequestException(
        `El cuadrante va de 1 a ${MAX_ROSTER_DAYS} días`,
      );
    }
    const to = addCivilDays(from, days - 1);
    const all = await this.locations.list();
    if (
      input.locationId !== undefined &&
      !all.some((l) => l.id === input.locationId)
    ) {
      throw new NotFoundException('Sede no encontrada');
    }
    // DX-089: una sede explícita fuera de las permitidas es 403 (como la
    // agenda); sin ella, el miembro acotado solo ve sus sedes y a quien
    // atiende en alguna de ellas (como las columnas de la agenda).
    if (input.locationId !== undefined) {
      this.tenantContext.assertLocationAllowed(input.locationId);
    }
    const visible = visibleLocation(this.tenantContext);
    const shown = all.filter((l) => visible(l.id));
    const providers = (await this.staff.listActive()).filter(
      (m) =>
        ATTENDING_ROLES.includes(m.role) &&
        shown.some((l) => attendsAt(m, l.id)),
    );
    const snapshots = await this.repo.findSnapshots(
      providers.map((p) => p.userId),
      { from, to },
    );
    const dates = Array.from({ length: days }, (_, i) => addCivilDays(from, i));
    const locationId = input.locationId ?? null;

    return {
      from,
      to,
      locationId,
      locations: shown.map((l) => ({
        id: l.id,
        name: l.name,
        timeZone: l.timeZone,
      })),
      providers: providers.map((p) => {
        const snapshot = snapshots.get(p.userId)!;
        return {
          providerId: p.userId,
          fullName: p.fullName,
          role: p.role,
          configured: snapshot.configured,
          days: dates.map((date): RosterDayView => {
            const assignments = providerDayAssignments(snapshot, date);
            // DX-121d: donde no atiende no se le puede citar: «no trabaja».
            const atLocation =
              locationId === null
                ? null
                : attendsAt(p, locationId)
                  ? providerRangesOn(snapshot, locationId, date)
                  : [];
            return {
              date,
              weekday: civilWeekday(date),
              unrestricted: !snapshot.configured && assignments.length === 0,
              assignments: assignments.filter((a) => visible(a.locationId)),
              worksAtLocation:
                locationId === null
                  ? null
                  : atLocation === null || atLocation.length > 0,
              locationRanges: atLocation,
            };
          }),
        };
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// Ajuste de la clínica
// ---------------------------------------------------------------------------

@Injectable()
export class GetProviderScheduleSettingsUseCase {
  constructor(
    @Inject(PROVIDER_SCHEDULE_REPOSITORY)
    private readonly repo: ProviderScheduleRepository,
  ) {}

  async execute(): Promise<ProviderScheduleSettings> {
    return { strictProviderSchedule: await this.repo.getStrict() };
  }
}

@Injectable()
export class UpdateProviderScheduleSettingsUseCase {
  constructor(
    @Inject(PROVIDER_SCHEDULE_REPOSITORY)
    private readonly repo: ProviderScheduleRepository,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  async execute(
    input: ProviderScheduleSettings,
    ctx: AuditRequestContext,
  ): Promise<ProviderScheduleSettings> {
    const before = await this.repo.getStrict();
    const after = await this.repo.setStrict(input.strictProviderSchedule);
    const label = (strict: boolean) => (strict ? 'STRICT' : 'WARN');
    await this.audit.record({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action: 'UPDATE',
      resourceType: 'PROVIDER_SCHEDULE',
      resourceId: null,
      patient: null,
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: {
        reason: 'PROVIDER_SCHEDULE_SETTINGS',
        statusChange: { from: label(before), to: label(after) },
      },
    });
    return { strictProviderSchedule: after };
  }
}
