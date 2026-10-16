export const REGISTRATION_REPOSITORY = Symbol('REGISTRATION_REPOSITORY');

/** Alta de clínica a la espera de que el email se verifique (DX-029). */
export interface PendingRegistrationRecord {
  id: string;
  email: string;
  clinicName: string;
  subdomain: string;
  fullName: string;
  passwordHash: string;
  expiresAt: Date;
}

export interface RegistrationRepository {
  /**
   * Guarda (o REEMPLAZA, si ya había uno para ese email) el registro
   * pendiente: el enlace anterior deja de servir.
   */
  savePending(
    input: Omit<PendingRegistrationRecord, 'id'> & { tokenHash: string },
  ): Promise<void>;

  findPendingByTokenHash(
    tokenHash: string,
  ): Promise<PendingRegistrationRecord | null>;

  /**
   * Borra el pendiente si sigue existiendo. Devuelve `true` solo a quien lo
   * borró: dos clics simultáneos en el enlace crean una sola clínica.
   */
  consumePending(id: string): Promise<boolean>;
}
