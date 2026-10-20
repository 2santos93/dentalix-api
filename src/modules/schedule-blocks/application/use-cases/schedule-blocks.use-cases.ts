import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole, ScheduleBlockKind } from '@prisma/client';
import type { ScheduleBlock } from '../../domain/entities/schedule-block.entity';
import {
  SCHEDULE_BLOCK_REPOSITORY,
  type AffectedAppointmentsPage,
  type ScheduleBlockRepository,
  type ScheduleBlockScope,
} from '../../domain/ports/schedule-block-repository.port';
import {
  ATTENDING_ROLES,
  MAX_AFFECTED_APPOINTMENTS,
  MAX_BLOCK_LIST_DAYS,
  NOT_ATTENDING_MESSAGE,
  SCHEDULE_BLOCK_NOT_FOUND_MESSAGE,
  SCHEDULE_BLOCK_OWN_ONLY_MESSAGE,
  scheduleBlockNoteError,
  scheduleBlockRangeError,
  scheduleBlockScopeError,
} from '../../domain/schedule-block-rules';
import {
  LOCATION_REPOSITORY,
  type LocationRepository,
} from '../../../locations/domain/ports/location-repository.port';
import {
  STAFF_REPOSITORY,
  type StaffRepository,
} from '../../../staff/domain/ports/staff-repository.port';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { locationNotAllowed } from '../../../../shared/tenancy/location-access';

/** Quién escribe: un odontólogo solo puede tocar su propia agenda. */
export interface ScheduleBlockActor {
  userId: string;
  role: ClinicRole;
}

export interface CreateScheduleBlockInput {
  providerId?: string;
  locationId?: string;
  start: Date;
  end: Date;
  kind: ScheduleBlockKind;
  allowsBooking?: boolean;
  note?: string;
  /** Hay citas dentro y quien bloquea ya las vio: se crea igualmente. */
  confirmAffected?: boolean;
}

export interface UpdateScheduleBlockInput {
  start?: Date;
  end?: Date;
  kind?: ScheduleBlockKind;
  allowsBooking?: boolean;
  /** `null` borra la nota. */
  note?: string | null;
  confirmAffected?: boolean;
}

/** Máximo de profesionales por consulta (las columnas de la vista Día). */
const MAX_PROVIDER_IDS = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

function assertValid(error: string | null): void {
  if (error !== null) throw new BadRequestException(error);
}

function affectedMessage(count: number): string {
  const citas = count === 1 ? '1 cita' : `${count} citas`;
  return `Hay ${citas} en ese horario. Las citas no se borran: revísalas y confirma el bloqueo.`;
}

/** La nota recortada (`undefined`/`null` se respetan). */
function cleanNote(note: string | null | undefined): string | null | undefined {
  if (note === undefined || note === null) return note;
  assertValid(scheduleBlockNoteError(note));
  return note.trim();
}

/**
 * Un odontólogo bloquea SOLO su propia agenda (sus vacaciones, su congreso);
 * los bloqueos de sede o de otro profesional son de recepción y ADMIN. La
 * asistente no llega aquí (`@Roles`).
 */
function assertCanWrite(
  actor: ScheduleBlockActor,
  providerId: string | null,
): void {
  if (actor.role === ClinicRole.DENTIST && providerId !== actor.userId) {
    throw new ForbiddenException(SCHEDULE_BLOCK_OWN_ONLY_MESSAGE);
  }
}

/**
 * DX-089: un bloqueo de sede solo lo escribe quien trabaja en esa sede; uno
 * «en todas las sedes» (`locationId: null`) afecta también a las ajenas, así
 * que solo quien tiene todas. Si no, 403 `LOCATION_NOT_ALLOWED`.
 */
function assertLocationWritable(
  tenantContext: TenantContextService,
  locationId: string | null,
): void {
  if (locationId !== null) {
    tenantContext.assertLocationAllowed(locationId);
  } else if (tenantContext.getAllowedLocationIds() !== 'ALL') {
    throw locationNotAllowed();
  }
}

/** Sede y profesional del cliente: tienen que ser de ESTA clínica (RLS). */
async function assertScopeBelongs(
  scope: ScheduleBlockScope,
  locations: LocationRepository,
  staff: StaffRepository,
): Promise<void> {
  if (
    scope.locationId !== null &&
    !(await locations.findById(scope.locationId))
  ) {
    throw new NotFoundException('Sede no encontrada');
  }
  if (scope.providerId !== null) {
    const member = await staff.findById(scope.providerId);
    if (!member) throw new NotFoundException('Profesional no encontrado');
    if (!ATTENDING_ROLES.includes(member.role)) {
      throw new BadRequestException(NOT_ATTENDING_MESSAGE);
    }
  }
}

@Injectable()
export class ListScheduleBlocksUseCase {
  constructor(
    @Inject(SCHEDULE_BLOCK_REPOSITORY)
    private readonly repo: ScheduleBlockRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    @Inject(STAFF_REPOSITORY)
    private readonly staff: StaffRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(params: {
    from: Date;
    to: Date;
    locationId?: string;
    providerIds?: string[];
  }): Promise<ScheduleBlock[]> {
    if (params.to.getTime() <= params.from.getTime()) {
      throw new BadRequestException(
        'El final del rango tiene que ser posterior al inicio',
      );
    }
    if (
      params.to.getTime() - params.from.getTime() >
      MAX_BLOCK_LIST_DAYS * DAY_MS
    ) {
      throw new BadRequestException(
        `Puedes consultar como mucho ${MAX_BLOCK_LIST_DAYS} días de bloqueos a la vez`,
      );
    }
    const providerIds = params.providerIds
      ? [...new Set(params.providerIds)]
      : undefined;
    if (providerIds && providerIds.length > MAX_PROVIDER_IDS) {
      throw new BadRequestException(
        `Puedes ver como mucho ${MAX_PROVIDER_IDS} profesionales a la vez`,
      );
    }
    // DX-089: sin sede explícita, el repositorio acota a las permitidas.
    if (params.locationId) {
      this.tenantContext.assertLocationAllowed(params.locationId);
    }
    if (
      params.locationId &&
      !(await this.locations.findById(params.locationId))
    ) {
      throw new NotFoundException('Sede no encontrada');
    }
    for (const id of providerIds ?? []) {
      if (!(await this.staff.findById(id))) {
        throw new NotFoundException('Profesional no encontrado');
      }
    }
    return this.repo.list({ ...params, providerIds });
  }
}

@Injectable()
export class ListAffectedAppointmentsUseCase {
  constructor(
    @Inject(SCHEDULE_BLOCK_REPOSITORY)
    private readonly repo: ScheduleBlockRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    @Inject(STAFF_REPOSITORY)
    private readonly staff: StaffRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Las citas que quedarían dentro de un bloqueo, antes de crearlo. */
  async execute(input: {
    providerId?: string;
    locationId?: string;
    start: Date;
    end: Date;
  }): Promise<AffectedAppointmentsPage> {
    const scope: ScheduleBlockScope = {
      providerId: input.providerId ?? null,
      locationId: input.locationId ?? null,
    };
    assertValid(scheduleBlockScopeError(scope));
    assertValid(scheduleBlockRangeError(input.start, input.end));
    assertLocationWritable(this.tenantContext, scope.locationId);
    await assertScopeBelongs(scope, this.locations, this.staff);
    return this.repo.findAffectedAppointments(
      { ...scope, start: input.start, end: input.end },
      MAX_AFFECTED_APPOINTMENTS,
    );
  }
}

@Injectable()
export class CreateScheduleBlockUseCase {
  constructor(
    @Inject(SCHEDULE_BLOCK_REPOSITORY)
    private readonly repo: ScheduleBlockRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    @Inject(STAFF_REPOSITORY)
    private readonly staff: StaffRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(
    input: CreateScheduleBlockInput,
    actor: ScheduleBlockActor,
  ): Promise<ScheduleBlock> {
    const scope: ScheduleBlockScope = {
      providerId: input.providerId ?? null,
      locationId: input.locationId ?? null,
    };
    assertValid(scheduleBlockScopeError(scope));
    assertValid(scheduleBlockRangeError(input.start, input.end));
    const note = cleanNote(input.note) ?? null;
    assertCanWrite(actor, scope.providerId);
    assertLocationWritable(this.tenantContext, scope.locationId);
    await assertScopeBelongs(scope, this.locations, this.staff);

    // Crear un bloqueo NUNCA borra ni mueve citas: si hay alguna dentro, se
    // pide confirmación explícita (la web enseña la lista antes).
    if (!input.confirmAffected) {
      const { total } = await this.repo.findAffectedAppointments(
        { ...scope, start: input.start, end: input.end },
        1,
      );
      if (total > 0) throw new ConflictException(affectedMessage(total));
    }

    return this.repo.create({
      ...scope,
      start: input.start,
      end: input.end,
      kind: input.kind,
      allowsBooking: input.allowsBooking ?? false,
      note,
      createdById: actor.userId,
    });
  }
}

@Injectable()
export class UpdateScheduleBlockUseCase {
  constructor(
    @Inject(SCHEDULE_BLOCK_REPOSITORY)
    private readonly repo: ScheduleBlockRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    @Inject(STAFF_REPOSITORY)
    private readonly staff: StaffRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Cambia rango, tipo, si deja agendar y la nota (no el alcance). */
  async execute(
    id: string,
    input: UpdateScheduleBlockInput,
    actor: ScheduleBlockActor,
  ): Promise<ScheduleBlock> {
    const current = await this.repo.findById(id);
    if (!current) throw new NotFoundException(SCHEDULE_BLOCK_NOT_FOUND_MESSAGE);
    assertCanWrite(actor, current.providerId);
    assertLocationWritable(this.tenantContext, current.locationId);

    const start = input.start ?? current.start;
    const end = input.end ?? current.end;
    assertValid(scheduleBlockRangeError(start, end));
    const note = cleanNote(input.note);

    const rangeChanged =
      start.getTime() !== current.start.getTime() ||
      end.getTime() !== current.end.getTime();
    // Endurecer un bloqueo (pasa a no dejar agendar) también deja citas
    // «dentro de un bloqueo»: se confirma igual que al ampliar el rango.
    const hardened = current.allowsBooking && input.allowsBooking === false;
    if ((rangeChanged || hardened) && !input.confirmAffected) {
      const { total } = await this.repo.findAffectedAppointments(
        {
          providerId: current.providerId,
          locationId: current.locationId,
          start,
          end,
        },
        1,
      );
      if (total > 0) throw new ConflictException(affectedMessage(total));
    }

    return this.repo.update(id, {
      start: input.start,
      end: input.end,
      kind: input.kind,
      allowsBooking: input.allowsBooking,
      note,
      updatedById: actor.userId,
    });
  }
}

@Injectable()
export class DeleteScheduleBlockUseCase {
  constructor(
    @Inject(SCHEDULE_BLOCK_REPOSITORY)
    private readonly repo: ScheduleBlockRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Borrado lógico: la agenda vuelve a quedar libre en ese rango. */
  async execute(id: string, actor: ScheduleBlockActor): Promise<void> {
    const current = await this.repo.findById(id);
    if (!current) throw new NotFoundException(SCHEDULE_BLOCK_NOT_FOUND_MESSAGE);
    assertCanWrite(actor, current.providerId);
    assertLocationWritable(this.tenantContext, current.locationId);
    await this.repo.softDelete(id, actor.userId);
  }
}
