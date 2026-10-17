import { Inject, Injectable } from '@nestjs/common';
import {
  generateConfirmationToken,
  hashConfirmationToken,
} from '../../appointment-confirmations/application/confirmation-token';
import {
  REMINDER_OPT_OUT_REPOSITORY,
  type ReminderOptOutRepository,
} from '../domain/ports/reminder-opt-out-repository.port';

/** Ruta pública de la web (src/app/(public)/baja/[token]). */
export const OPT_OUT_PATH = '/baja';

/**
 * Enlace de baja de cada email de recordatorio (DX-128). Mismo esquema que el
 * enlace de confirmación de DX-005: 32 bytes aleatorios en base64url que solo
 * viajan en el email, y su SHA-256 en la BD. Uno por email.
 */
@Injectable()
export class ReminderOptOutLinks {
  constructor(
    @Inject(REMINDER_OPT_OUT_REPOSITORY)
    private readonly repo: ReminderOptOutRepository,
  ) {}

  /** Emite un enlace para el paciente (clínica del contexto) y devuelve el token. */
  async issue(patientId: string): Promise<string> {
    const token = generateConfirmationToken();
    await this.repo.issueLink(patientId, hashConfirmationToken(token));
    return token;
  }
}
