import { ApiProperty } from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import type { InvitationStatus } from '../../domain/entities/clinic-invitation.entity';

const PUBLIC_INVITATION_STATUS_VALUES: Array<InvitationStatus | 'NOT_FOUND'> = [
  'VALID',
  'EXPIRED',
  'USED',
  'REVOKED',
  'NOT_FOUND',
];

// Response shape for the PUBLIC GET /public/invitations/:token — always 200
// (see GetInvitationUseCase, which never throws). `clinicName`/`role`/
// `maskedEmail`/`requiresCurrentPassword` are only present when
// `status === 'VALID'`. DX-029: `userExists` se retiró (enumeración, SEC-006).
export class PublicInvitationDto {
  @ApiProperty({ enum: PUBLIC_INVITATION_STATUS_VALUES })
  status!: InvitationStatus | 'NOT_FOUND';

  @ApiProperty({ required: false })
  clinicName?: string;

  @ApiProperty({ enum: ClinicRole, required: false })
  role?: ClinicRole;

  @ApiProperty({ required: false })
  maskedEmail?: string;

  @ApiProperty({
    required: false,
    description:
      'true = el email ya tiene una cuenta verificada: pide la contraseña actual. false = pide crear una contraseña (cuenta nueva, o cuenta sin verificar que se reclama). El token solo llega por email a la persona invitada.',
  })
  requiresCurrentPassword?: boolean;
}
