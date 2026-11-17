import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentType } from '../../domain/entities/appointment-type.entity';
import {
  APPOINTMENT_TYPE_REPOSITORY,
  type AppointmentTypeRepository,
} from '../../domain/ports/appointment-type-repository.port';
import {
  appointmentTypeColorError,
  appointmentTypeDurationError,
  appointmentTypeNameError,
  normalizeAppointmentTypeColor,
  preVisitInstructionsFromEntries,
  type PreVisitInstructionEntry,
} from '../../domain/appointment-type-rules';

import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

export const APPOINTMENT_TYPE_NOT_FOUND_MESSAGE = 'Tipo de cita no encontrado';

export interface AppointmentTypeInput {
  name: string;
  durationMinutes: number;
  color: string;
  active?: boolean;
  /** DX-446: tipo de urgencia. */
  isUrgent?: boolean;
  /** DX-564: la lista entera (vacía = sin indicaciones). */
  preVisitInstructions?: PreVisitInstructionEntry[];
}

type NormalizedInput = Omit<
  Partial<AppointmentTypeInput>,
  'preVisitInstructions'
>;

function assertValid(error: string | null): void {
  if (error !== null) throw new BadRequestException(error);
}

/** Valida y normaliza solo los campos presentes (crear los trae todos). */
function normalize(input: Partial<AppointmentTypeInput>): NormalizedInput {
  const out: NormalizedInput = {
    active: input.active,
    isUrgent: input.isUrgent,
  };
  if (input.name !== undefined) {
    assertValid(appointmentTypeNameError(input.name));
    out.name = input.name.trim();
  }
  if (input.durationMinutes !== undefined) {
    assertValid(appointmentTypeDurationError(input.durationMinutes));
    out.durationMinutes = input.durationMinutes;
  }
  if (input.color !== undefined) {
    assertValid(appointmentTypeColorError(input.color));
    out.color = normalizeAppointmentTypeColor(input.color);
  }
  return out;
}

/**
 * DX-564: valida las indicaciones contra los idiomas de la clínica y devuelve
 * el mapa que se guarda; `undefined` si no vinieron (no se tocan).
 */
async function preVisitInstructions(
  repo: AppointmentTypeRepository,
  entries: PreVisitInstructionEntry[] | undefined,
  current: Readonly<Record<string, string>>,
): Promise<Record<string, string> | undefined> {
  if (entries === undefined) return undefined;
  const result = preVisitInstructionsFromEntries(entries, {
    patientLanguages: entries.length > 0 ? await repo.patientLanguages() : [],
    current,
  });
  if ('error' in result) throw new BadRequestException(result.error);
  return result.map;
}

@Injectable()
export class ListAppointmentTypesUseCase {
  constructor(
    @Inject(APPOINTMENT_TYPE_REPOSITORY)
    private readonly repo: AppointmentTypeRepository,
  ) {}

  /** Por defecto solo los activos (el selector del formulario de cita). */
  execute(params: { includeInactive?: boolean }): Promise<AppointmentType[]> {
    return this.repo.list({ includeInactive: params.includeInactive ?? false });
  }
}

/**
 * DX-564: un tipo por id, aunque esté desactivado o retirado: la cita lo
 * conserva y sus indicaciones previas se siguen enviando, así que recepción
 * tiene que poder ver lo que recibe el paciente. Fuera de la clínica, 404.
 */
@Injectable()
export class GetAppointmentTypeUseCase {
  constructor(
    @Inject(APPOINTMENT_TYPE_REPOSITORY)
    private readonly repo: AppointmentTypeRepository,
  ) {}

  async execute(id: string): Promise<AppointmentType> {
    const type = await this.repo.findByIdIncludingRetired(id);
    if (!type) throw new NotFoundException(APPOINTMENT_TYPE_NOT_FOUND_MESSAGE);
    return type;
  }
}

@Injectable()
export class CreateAppointmentTypeUseCase {
  constructor(
    @Inject(APPOINTMENT_TYPE_REPOSITORY)
    private readonly repo: AppointmentTypeRepository,
  ) {}

  async execute(
    input: AppointmentTypeInput,
    audit: AuditRequestContext,
  ): Promise<AppointmentType> {
    const valid = normalize(input) as Required<NormalizedInput>;
    const instructions = await preVisitInstructions(
      this.repo,
      input.preVisitInstructions,
      {},
    );
    return this.repo.create(
      {
        name: valid.name,
        durationMinutes: valid.durationMinutes,
        color: valid.color,
        active: input.active ?? true,
        isUrgent: input.isUrgent ?? false,
        preVisitInstructions: instructions ?? {},
        createdById: audit.actor.userId,
      },
      audit,
    );
  }
}

@Injectable()
export class UpdateAppointmentTypeUseCase {
  constructor(
    @Inject(APPOINTMENT_TYPE_REPOSITORY)
    private readonly repo: AppointmentTypeRepository,
  ) {}

  /**
   * Cambiar nombre, duración o color, o desactivarlo, NO toca las citas que ya
   * lo usan: su hora de fin quedó fijada al agendar y el tipo solo se embebe
   * para pintarlo.
   */
  async execute(
    id: string,
    input: Partial<AppointmentTypeInput>,
    audit: AuditRequestContext,
  ): Promise<AppointmentType> {
    const current = await this.repo.findById(id);
    if (!current) {
      throw new NotFoundException(APPOINTMENT_TYPE_NOT_FOUND_MESSAGE);
    }
    const valid = normalize(input);
    const instructions = await preVisitInstructions(
      this.repo,
      input.preVisitInstructions,
      current.preVisitInstructions,
    );
    return this.repo.update(
      id,
      {
        ...valid,
        preVisitInstructions: instructions,
        updatedById: audit.actor.userId,
      },
      audit,
    );
  }
}

@Injectable()
export class DeleteAppointmentTypeUseCase {
  constructor(
    @Inject(APPOINTMENT_TYPE_REPOSITORY)
    private readonly repo: AppointmentTypeRepository,
  ) {}

  /** Borrado lógico: el tipo sale de la gestión; sus citas lo conservan. */
  async execute(id: string, audit: AuditRequestContext): Promise<void> {
    const current = await this.repo.findById(id);
    if (!current) {
      throw new NotFoundException(APPOINTMENT_TYPE_NOT_FOUND_MESSAGE);
    }
    await this.repo.softDelete(id, audit);
  }
}
