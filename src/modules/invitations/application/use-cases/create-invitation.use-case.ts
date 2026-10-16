import {
  BadRequestException,
  ConflictException,
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

export const INVITATION_TTL_DAYS = 7;
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
  /** Texto plano del token — se entrega SOLO aquí, nunca se persiste ni se vuelve a exponer. */
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
  ) {}

  async execute(input: CreateInvitationInput): Promise<CreateInvitationResult> {
    const email = input.email.trim().toLowerCase();
    const fullName = input.fullName.trim();
    if (fullName.length < 2) {
      throw new BadRequestException('fullName must be at least 2 characters');
    }
    if (!Object.values(ClinicRole).includes(input.role)) {
      throw new BadRequestException('invalid role');
    }

    const activeMembership = await this.repo.findActiveMembershipByEmail(email);
    if (activeMembership) {
      throw new ConflictException('Email already an active member');
    }

    // "Reenviar" = superseder la invitación pendiente anterior, nunca
    // apilarla — así solo hay un token válido vigente por correo.
    const revokedIds = await this.repo.revokePendingByEmail(email);
    // Su email, si seguía pendiente, llevaría un enlace que ya no sirve.
    for (const id of revokedIds) {
      await this.notifier.cancelPending(id);
    }

    const token = generateInvitationToken();
    const tokenHash = hashInvitationToken(token);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    const invitation = await this.repo.create({
      email,
      fullName,
      role: input.role,
      tokenHash,
      expiresAt,
      invitedById: input.invitedById,
    });

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
