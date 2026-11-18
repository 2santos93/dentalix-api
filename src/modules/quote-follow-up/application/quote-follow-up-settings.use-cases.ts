import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  QUOTE_FOLLOW_UP_REPOSITORY,
  type LocationQuoteFollowUpSettingsView,
  type QuoteFollowUpRepository,
} from '../domain/ports/quote-follow-up-repository.port';
import {
  quoteFollowUpSettingsError,
  type QuoteFollowUpSettingsInput,
} from '../domain/quote-follow-up-settings';

export const QUOTE_FOLLOW_UP_LOCATION_NOT_FOUND_MESSAGE = 'Sede no encontrada';

/** Ajustes del seguimiento de cada sede viva de la clínica (DX-561, D1). */
@Injectable()
export class ListQuoteFollowUpSettingsUseCase {
  constructor(
    @Inject(QUOTE_FOLLOW_UP_REPOSITORY)
    private readonly repo: QuoteFollowUpRepository,
  ) {}

  execute(): Promise<LocationQuoteFollowUpSettingsView[]> {
    return this.repo.listSettings();
  }
}

/**
 * Reemplaza los ajustes de UNA sede. La sede se comprueba bajo RLS: un id de
 * otra clínica da 404, igual que uno inexistente. Los avisos ya encolados se
 * reevalúan al salir (el trabajo relee los ajustes vigentes).
 */
@Injectable()
export class UpdateQuoteFollowUpSettingsUseCase {
  constructor(
    @Inject(QUOTE_FOLLOW_UP_REPOSITORY)
    private readonly repo: QuoteFollowUpRepository,
  ) {}

  async execute(
    locationId: string,
    input: QuoteFollowUpSettingsInput,
    audit: AuditRequestContext,
  ): Promise<LocationQuoteFollowUpSettingsView> {
    const error = quoteFollowUpSettingsError(input);
    if (error) throw new BadRequestException(error);
    const saved = await this.repo.saveSettings(locationId, input, audit);
    if (!saved) {
      throw new NotFoundException(QUOTE_FOLLOW_UP_LOCATION_NOT_FOUND_MESSAGE);
    }
    return saved;
  }
}
