import { ClinicRole } from '@prisma/client';
import { ClinicInvitation } from '../entities/clinic-invitation.entity';

export const INVITATION_REPOSITORY = Symbol('INVITATION_REPOSITORY');

export interface AcceptOutcome {
  userId: string;
  role: ClinicRole;
}

export interface InvitationRepository {
  /** Pendientes (no aceptadas, no revocadas, no borradas) del tenant en contexto. */
  listPending(): Promise<ClinicInvitation[]>;

  /** Busca por hash del token (nunca por el texto plano). */
  findByTokenHash(tokenHash: string): Promise<ClinicInvitation | null>;

  /**
   * Membresía ACTIVA (no borrada) por correo, dentro del tenant en contexto
   * (RLS ya limita a `clinic_memberships`). Usado para no invitar a quien ya
   * es personal activo de esta clínica.
   */
  findActiveMembershipByEmail(
    email: string,
  ): Promise<{ userId: string } | null>;

  /**
   * `users` es tabla global (sin RLS): búsqueda por correo en todo el
   * sistema. Usado para decidir si la invitación crea un `User` nuevo o
   * reutiliza uno existente al aceptar.
   */
  findUserByEmailGlobal(
    email: string,
  ): Promise<{ id: string; passwordHash: string } | null>;

  /** Revoca la invitación PENDIENTE de ese correo, si existe. Devuelve cuántas revocó. */
  revokePendingByEmail(email: string): Promise<number>;

  /** Revoca la invitación por id. Devuelve si afectó una fila. */
  revokeById(id: string): Promise<boolean>;

  /**
   * Nombre del tenant en contexto, para mostrarlo en la pantalla pública de
   * "aceptar invitación" (`GetInvitationUseCase`). `null` si el tenant no
   * existe (no debería ocurrir en la práctica).
   */
  findTenantName(): Promise<string | null>;

  create(input: {
    email: string;
    fullName: string;
    role: ClinicRole;
    tokenHash: string;
    expiresAt: Date;
    invitedById?: string;
  }): Promise<ClinicInvitation>;

  /**
   * Transacción de aceptación: crea el usuario si `newUser` viene, crea o
   * REACTIVA la membresía (limpiando `deletedAt` y aplicando el rol), y marca
   * la invitación como aceptada. Todo o nada.
   */
  acceptTransactional(input: {
    invitationId: string;
    email: string;
    role: ClinicRole;
    existingUserId?: string;
    newUser?: { fullName: string; passwordHash: string };
  }): Promise<AcceptOutcome>;
}
