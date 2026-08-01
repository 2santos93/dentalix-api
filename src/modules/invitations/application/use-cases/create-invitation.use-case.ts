import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { INVITATION_REPOSITORY } from '../../domain/ports/invitation-repository.port';
import type { InvitationRepository } from '../../domain/ports/invitation-repository.port';
import { ClinicInvitation } from '../../domain/entities/clinic-invitation.entity';
import { generateInvitationToken, hashInvitationToken } from '../invitation-token';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreateInvitationInput {
  fullName: string;
  email: string;
  role: ClinicRole;
  invitedById?: string;
}

export interface CreateInvitationResult {
  invitation: ClinicInvitation;
  /** Texto plano del token — se entrega SOLO aquí, nunca se persiste ni se vuelve a exponer. */
  token: string;
}

@Injectable()
export class CreateInvitationUseCase {
  constructor(
    @Inject(INVITATION_REPOSITORY)
    private readonly repo: InvitationRepository,
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
    await this.repo.revokePendingByEmail(email);

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

    return { invitation, token };
  }
}
