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

// POST /staff/invitations (y /:id/resend) devuelve el token en claro UNA vez
// junto a la invitación: la web arma el enlace con `window.location.origin`
// para que el ADMIN pueda copiarlo además del email (DX-088).
export class CreatedInvitationDto extends InvitationDto {
  @ApiProperty()
  token!: string;

  @ApiProperty({
    enum: ['PENDING', 'SENT', 'FAILED'],
    nullable: true,
    type: String,
    description:
      'Estado del email con el enlace: PENDING = encolado (se envía en segundo plano); null = no se pudo encolar (comparte el enlace o reenvía)',
  })
  emailDelivery!: 'PENDING' | 'SENT' | 'FAILED' | null;
}
