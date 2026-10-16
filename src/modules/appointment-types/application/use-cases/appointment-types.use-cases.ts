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
} from '../../domain/appointment-type-rules';

export const APPOINTMENT_TYPE_NOT_FOUND_MESSAGE = 'Tipo de cita no encontrado';

export interface AppointmentTypeInput {
  name: string;
  durationMinutes: number;
  color: string;
  active?: boolean;
}

function assertValid(error: string | null): void {
  if (error !== null) throw new BadRequestException(error);
}

/** Valida y normaliza solo los campos presentes (crear los trae todos). */
function normalize(
  input: Partial<AppointmentTypeInput>,
): Partial<AppointmentTypeInput> {
  const out: Partial<AppointmentTypeInput> = { active: input.active };
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

@Injectable()
export class CreateAppointmentTypeUseCase {
  constructor(
    @Inject(APPOINTMENT_TYPE_REPOSITORY)
    private readonly repo: AppointmentTypeRepository,
  ) {}

  async execute(
    input: AppointmentTypeInput,
    createdById?: string,
  ): Promise<AppointmentType> {
    const valid = normalize(input) as AppointmentTypeInput;
    return this.repo.create({
      name: valid.name,
      durationMinutes: valid.durationMinutes,
      color: valid.color,
      active: input.active ?? true,
      createdById,
    });
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
    updatedById?: string,
  ): Promise<AppointmentType> {
    const current = await this.repo.findById(id);
    if (!current) {
      throw new NotFoundException(APPOINTMENT_TYPE_NOT_FOUND_MESSAGE);
    }
    return this.repo.update(id, { ...normalize(input), updatedById });
  }
}

@Injectable()
export class DeleteAppointmentTypeUseCase {
  constructor(
    @Inject(APPOINTMENT_TYPE_REPOSITORY)
    private readonly repo: AppointmentTypeRepository,
  ) {}

  /** Borrado lógico: el tipo sale de la gestión; sus citas lo conservan. */
  async execute(id: string, deletedById?: string): Promise<void> {
    const current = await this.repo.findById(id);
    if (!current) {
      throw new NotFoundException(APPOINTMENT_TYPE_NOT_FOUND_MESSAGE);
    }
    await this.repo.softDelete(id, deletedById);
  }
}
