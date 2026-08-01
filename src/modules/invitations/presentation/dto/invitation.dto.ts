import { ApiProperty } from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import type { InvitationStatus } from '../../domain/entities/clinic-invitation.entity';

const INVITATION_STATUS_VALUES: InvitationStatus[] = [
  'VALID',
  'EXPIRED',
  'USED',
  'REVOKED',
];

// Response shape for GET /staff/invitations (and the CreatedInvitationDto
// base below) — documents the pending-invitation contract for Swagger. The
// use cases already return values shaped exactly like this
// (ClinicInvitation & { status }); this class exists purely for
// `@ApiProperty` documentation, not for input validation.
export class InvitationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ enum: ClinicRole })
  role!: ClinicRole;

  @ApiProperty()
  expiresAt!: Date;

  @ApiProperty({ enum: INVITATION_STATUS_VALUES })
  status!: InvitationStatus;
}

// POST /staff/invitations returns the clear-text token ONCE alongside the
// invitation — the frontend composes the accept URL with
// `window.location.origin`, the backend never guesses protocol/port.
export class CreatedInvitationDto extends InvitationDto {
  @ApiProperty()
  token!: string;
}
