import { ClinicRole } from '@prisma/client';
import { ClinicInvitation } from '../entities/clinic-invitation.entity';

export const INVITATION_REPOSITORY = Symbol('INVITATION_REPOSITORY');

export interface AcceptOutcome {
  userId: string;
  role: ClinicRole;
}

/** Usuario global (tabla `users`) con lo necesario para aceptar y emitir. */
export interface GlobalUserRecord {
  id: string;
  passwordHash: string;
  /** `User.tokenVersion`: el par emitido al aceptar debe llevarla (`tv`). */
  tokenVersion: number;
  /**
   * Cuándo se probó que la persona controla el email (DX-029). `null` = la
   * cuenta se creó sin probarlo (p. ej. antes de DX-029) y se puede
   * «reclamar» desde un enlace que llegó a ese email.
   */
  emailVerifiedAt: Date | null;
  /**
   * Administrador de PLATAFORMA (acceso a todas las clínicas): nunca se puede
   * reclamar (DX-143).
   */
  isPlatformAdmin: boolean;
}

/**
 * Cómo se resuelve el usuario al aceptar (DX-029):
 * - `newUser`: no había cuenta; nace con el email verificado.
 * - `existingUserId`: cuenta existente cuya contraseña se comprobó; si no
 *   estaba verificada, se marca (el enlace llegó a su email).
 * - `claim`: cuenta existente NO verificada y contraseña distinta: quien abre
 *   el enlace controla el email y se queda con la cuenta. Nueva contraseña,
 *   `tokenVersion` + 1 (todas las sesiones y refresh anteriores dejan de
 *   valer) y se invalidan los enlaces de restablecimiento pendientes.
 */
/** La cuenta a reclamar se verificó mientras tanto (carrera): no se tocó nada. */
export class AccountClaimConflictError extends Error {
  constructor() {
    super('account claim lost a race');
  }
}

/**
 * DX-143 (SEC-033): la cuenta a reclamar da acceso a OTRA clínica (o a la
 * plataforma), comprobado dentro de la transacción: no se tocó nada.
 */
export class AccountClaimBlockedError extends Error {
  constructor() {
    super('account claim blocked: access to another clinic');
  }
}

export type AcceptUserResolution =
  | { newUser: { fullName: string; passwordHash: string } }
  | { existingUserId: string }
  | { claim: { userId: string; passwordHash: string } };

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
  findUserByEmailGlobal(email: string): Promise<GlobalUserRecord | null>;

  /**
   * DX-143 (SEC-033): ¿tiene el usuario alguna membresía ACTIVA (no borrada)
   * en una clínica distinta de la del contexto? `clinic_memberships` está
   * bajo RLS por clínica: lo responde la función SECURITY DEFINER
   * `dx_user_has_other_active_memberships` (solo un booleano).
   */
  hasOtherActiveMemberships(userId: string): Promise<boolean>;

  /** Revoca la invitación PENDIENTE de ese correo, si existe. Devuelve los ids revocados. */
  revokePendingByEmail(email: string): Promise<string[]>;

  /** Revoca la invitación por id. Devuelve si afectó una fila. */
  revokeById(id: string): Promise<boolean>;

  /** Invitación aún no aceptada ni revocada (caducada o no) por id, o `null`. */
  findPendingById(id: string): Promise<ClinicInvitation | null>;

  /**
   * «Reenviar invitación» (DX-088): a una invitación aún no aceptada ni
   * revocada (caducada o no) le pone un token y una caducidad nuevos. El hash
   * anterior se sobrescribe, así que el enlace viejo deja de existir. `null`
   * si no hay ninguna invitación así con ese id en el tenant en contexto.
   */
  reissue(
    id: string,
    input: { tokenHash: string; expiresAt: Date },
  ): Promise<ClinicInvitation | null>;

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
   * Invitaciones CREADAS en la clínica en contexto desde `since` (límite
   * diario por clínica, DX-029).
   */
  countCreatedSince(since: Date): Promise<number>;

  /**
   * Transacción de aceptación: resuelve el usuario (`user`, ver
   * AcceptUserResolution) marcando su email como verificado, crea o REACTIVA
   * la membresía (limpiando `deletedAt` y aplicando el rol), y marca la
   * invitación como aceptada. Todo o nada. En `claim` vuelve a comprobar,
   * con la fila del usuario bloqueada, que la cuenta sigue sin verificar
   * (`AccountClaimConflictError`) y que no da acceso a otra clínica ni a la
   * plataforma (`AccountClaimBlockedError`). `tokenVersion` es la vigente tras
   * la transacción (la del par que se emite).
   */
  acceptTransactional(input: {
    invitationId: string;
    email: string;
    role: ClinicRole;
    user: AcceptUserResolution;
  }): Promise<AcceptOutcome & { tokenVersion: number }>;
}
