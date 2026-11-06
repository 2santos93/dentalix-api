import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ClinicRole, Prisma } from '@prisma/client';
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

/** DX-149-bis: otra alta del mismo correo confirmó mientras se creaba esta. */
export const INVITATION_RACE =
  'Ya hay una invitación pendiente para este correo (se acaba de enviar). Revisa la lista de invitaciones.';

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

    const id = randomUUID();
    const token = generateInvitationToken();
    const tokenHash = hashInvitationToken(token);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    // El email se prepara (marca, cifrado) ANTES de abrir la transacción.
    const mail = input.linkBase
      ? await this.notifier.prepareInvitation({
          invitation: {
            id,
            tenantId: ctx.tenantId,
            email,
            fullName,
            role: input.role,
          },
          token,
          linkBase: input.linkBase,
        })
      : null;

    // DX-149-bis: revocar la anterior, crear esta y encolar su email en UNA
    // transacción, con el tope contado bajo candado. De dos altas a la vez, la
    // segunda recibe un 409 (índice único de pendientes) o el 429 del tope y
    // no toca nada: queda una sola invitación viva, con su email.
    let invitation: ClinicInvitation;
    try {
      invitation = await this.repo.createReplacingPending(
        {
          id,
          email,
          fullName,
          role: input.role,
          tokenHash,
          expiresAt,
          invitedById: input.invitedById,
        },
        ctx,
        async (tx, revokedIds) => {
          // Su email, si seguía pendiente, llevaría un enlace que ya no sirve.
          await this.notifier.cancelPendingInTx(tx, revokedIds);
          if (mail) await mail.insert(tx);
        },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(INVITATION_RACE);
      }
      throw error;
    }
    // Tras el COMMIT y sin esperar al proveedor: el despachador envía el
    // email en segundo plano (DX-088).
    mail?.kick();

    return { invitation, token, emailDelivery: mail ? 'PENDING' : null };
  }
}
