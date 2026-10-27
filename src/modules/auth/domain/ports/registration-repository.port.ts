import type { ClinicLocationSettings } from './auth-repository.port';

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
  /**
   * G1: la primera sede. `null` = pendiente legado (sin los cuatro campos:
   * creado por una réplica o una web anteriores a G1).
   */
  location: ClinicLocationSettings | null;
}

export interface RegistrationRepository {
  /**
   * Guarda el registro pendiente. Si ya había uno para ese email solo lo
   * REEMPLAZA (y su enlace deja de servir) cuando se creó antes de
   * `replaceCreatedBefore` o ya caducó (DX-144: otra petición no puede
   * invalidar el enlace de quien se está registrando). Atómico: de varias
   * peticiones a la vez, como mucho una guarda. Devuelve si guardó. Al
   * reemplazar, también sobrescribe los datos de la sede (G1).
   */
  savePending(
    input: Omit<PendingRegistrationRecord, 'id'> & {
      tokenHash: string;
      replaceCreatedBefore: Date;
    },
  ): Promise<boolean>;

  findPendingByTokenHash(
    tokenHash: string,
  ): Promise<PendingRegistrationRecord | null>;

  /**
   * Borra el pendiente si sigue existiendo. Devuelve `true` solo a quien lo
   * borró: dos clics simultáneos en el enlace crean una sola clínica.
   */
  consumePending(id: string): Promise<boolean>;
}
