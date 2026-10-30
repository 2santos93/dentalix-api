import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { INVITATION_REPOSITORY } from '../../domain/ports/invitation-repository.port';
import type { InvitationRepository } from '../../domain/ports/invitation-repository.port';
import { INVITATION_NOTIFIER } from '../../domain/ports/invitation-notifier.port';
import type {
  InvitationEmailDelivery,
  InvitationNotifier,
} from '../../domain/ports/invitation-notifier.port';
import { ClinicInvitation } from '../../domain/entities/clinic-invitation.entity';
import {
  generateInvitationToken,
  hashInvitationToken,
} from '../invitation-token';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

export const INVITATION_TTL_DAYS = 7;

/** Tope de invitaciones nuevas por clínica en 24 h (DX-029). */
export const INVITATION_LIMITS = Symbol('INVITATION_LIMITS');
export interface InvitationLimits {
  /** INVITATION_TENANT_DAILY_LIMIT (default 30). */
  tenantDaily: number;
}
export const DEFAULT_INVITATION_TENANT_DAILY = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
export const INVITATION_TTL_MS = INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;

export interface CreateInvitationInput {
  fullName: string;
  email: string;
  role: ClinicRole;
  invitedById?: string;
  /**
   * Origen público de la web de la clínica (`https://demo.dentalix.app`) para
   * el enlace del email (DX-088). Sin él (seed demo) no se envía email.
   */
  linkBase?: string;
}

export interface CreateInvitationResult {
  invitation: ClinicInvitation;
  /**
   * Texto plano del token: solo para el email (y el seed demo). Nunca se
   * persiste ni sale por la API (DX-029).
   */
  token: string;
  /** Estado del email: PENDING si se encoló, `null` si no hubo email. */
  emailDelivery: InvitationEmailDelivery | null;
}

@Injectable()
export class CreateInvitationUseCase {
  constructor(
    @Inject(INVITATION_REPOSITORY)
    private readonly repo: InvitationRepository,
    @Inject(INVITATION_NOTIFIER)
    private readonly notifier: InvitationNotifier,
    @Inject(INVITATION_LIMITS)
    private readonly limits: InvitationLimits,
  ) {}

  /**
   * DX-359: `ctx` es quién invita; el alta (y la anulación de la pendiente
   * que sustituye) quedan auditadas en su transacción.
   */
  async execute(
    input: CreateInvitationInput,
    ctx: AuditRequestContext,
  ): Promise<CreateInvitationResult> {
    const email = input.email.trim().toLowerCase();
    const fullName = input.fullName.trim();
    if (fullName.length < 2) {
      throw new BadRequestException('fullName must be at least 2 characters');
    }
    if (!Object.values(ClinicRole).includes(input.role)) {
      throw new BadRequestException('invalid role');
    }

    // Tope diario por clínica (DX-029, SEC-006): una clínica gratis no puede
    // invitar en bucle. Solo cuenta las invitaciones NUEVAS: reenviar ya
    // tiene sus topes por destinatario (DX-088).
    const createdToday = await this.repo.countCreatedSince(
      new Date(Date.now() - DAY_MS),
    );
    if (createdToday >= this.limits.tenantDaily) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: `La clínica alcanzó el máximo de ${this.limits.tenantDaily} invitaciones en 24 horas. Vuelve a intentarlo mañana o escribe a soporte si necesitas más.`,
          retryAfterSeconds: 60 * 60,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const activeMembership = await this.repo.findActiveMembershipByEmail(email);
    if (activeMembership) {
      throw new ConflictException('Email already an active member');
    }

    // "Reenviar" = superseder la invitación pendiente anterior, nunca
    // apilarla — así solo hay un token válido vigente por correo.
    // Topes anti-abuso ANTES de tocar nada: si no se puede mandar el email,
    // no se revoca la anterior ni se crea otra.
    if (input.linkBase) {
      await this.notifier.assertCanSend(email);
    }

    const revokedIds = await this.repo.revokePendingByEmail(email, ctx);
    // Su email, si seguía pendiente, llevaría un enlace que ya no sirve.
    for (const id of revokedIds) {
      await this.notifier.cancelPending(id);
    }

    const token = generateInvitationToken();
    const tokenHash = hashInvitationToken(token);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    const invitation = await this.repo.create(
      {
        email,
        fullName,
        role: input.role,
        tokenHash,
        expiresAt,
        invitedById: input.invitedById,
      },
      ctx,
    );

    // Después del commit de la invitación y sin esperar al proveedor: el
    // despachador envía el email en segundo plano (DX-088).
    const emailDelivery = input.linkBase
      ? await this.notifier.sendInvitation({
          invitation,
          token,
          linkBase: input.linkBase,
        })
      : null;

    return { invitation, token, emailDelivery };
  }
}
