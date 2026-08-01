import { ApiProperty } from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import type { InvitationStatus } from '../../domain/entities/clinic-invitation.entity';

const PUBLIC_INVITATION_STATUS_VALUES: Array<InvitationStatus | 'NOT_FOUND'> =
  ['VALID', 'EXPIRED', 'USED', 'REVOKED', 'NOT_FOUND'];

// Response shape for the PUBLIC GET /public/invitations/:token — always 200
// (see GetInvitationUseCase, which never throws). `clinicName`/`role`/
// `maskedEmail`/`userExists` are only present when `status === 'VALID'`.
export class PublicInvitationDto {
  @ApiProperty({ enum: PUBLIC_INVITATION_STATUS_VALUES })
  status!: InvitationStatus | 'NOT_FOUND';

  @ApiProperty({ required: false })
  clinicName?: string;

  @ApiProperty({ enum: ClinicRole, required: false })
  role?: ClinicRole;

  @ApiProperty({ required: false })
  maskedEmail?: string;

  @ApiProperty({ required: false })
  userExists?: boolean;
}
