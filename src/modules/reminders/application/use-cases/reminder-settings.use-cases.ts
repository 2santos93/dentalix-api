import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  REMINDER_REPOSITORY,
  type LocationReminderSettingsView,
  type ReminderRepository,
} from '../../domain/ports/reminder-repository.port';
import {
  normalizeLeadHours,
  settingsError,
  type ReminderSettingsInput,
} from '../../domain/reminder-lead-hours';

export const LOCATION_NOT_FOUND_MESSAGE = 'Sede no encontrada';

/** Ajustes de recordatorio de cada sede viva de la clínica (DX-026). */
@Injectable()
export class ListReminderSettingsUseCase {
  constructor(
    @Inject(REMINDER_REPOSITORY) private readonly repo: ReminderRepository,
  ) {}

  execute(): Promise<LocationReminderSettingsView[]> {
    return this.repo.listSettings();
  }
}

/**
 * Reemplaza los ajustes de UNA sede. La sede se comprueba bajo RLS: un id de
 * otra clínica da 404, igual que uno inexistente. Los recordatorios ya
 * encolados se reevalúan al salir (el handler relee los ajustes vigentes).
 */
@Injectable()
export class UpdateReminderSettingsUseCase {
  constructor(
    @Inject(REMINDER_REPOSITORY) private readonly repo: ReminderRepository,
  ) {}

  async execute(
    locationId: string,
    input: ReminderSettingsInput,
    updatedById?: string,
  ): Promise<LocationReminderSettingsView> {
    const error = settingsError(input);
    if (error) throw new BadRequestException(error);
    const saved = await this.repo.saveSettings(
      locationId,
      {
        enabled: input.enabled,
        leadHours: normalizeLeadHours(input.leadHours),
      },
      updatedById,
    );
    if (!saved) throw new NotFoundException(LOCATION_NOT_FOUND_MESSAGE);
    return saved;
  }
}
