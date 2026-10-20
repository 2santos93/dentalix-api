import { ApiProperty } from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import { STAFF_DIRECTORY_STATUSES } from './list-staff-directory-query.dto';

// Solo documentación para Swagger: el caso de uso ya devuelve exactamente esta
// forma (entidad `StaffDirectoryEntry`), igual que `StaffMemberDto`.
export class StaffDirectoryEntryDto {
  @ApiProperty({
    enum: ['MEMBER', 'INVITATION'],
    description:
      'MEMBER = persona con acceso; INVITATION = invitación sin aceptar',
  })
  kind!: 'MEMBER' | 'INVITATION';

  @ApiProperty({
    format: 'uuid',
    description: 'userId si es MEMBER, id de la invitación si es INVITATION',
  })
  id!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ enum: ClinicRole })
  role!: ClinicRole;

  @ApiProperty({ enum: STAFF_DIRECTORY_STATUSES })
  status!: (typeof STAFF_DIRECTORY_STATUSES)[number];

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Caducidad del enlace; null en los miembros',
  })
  expiresAt!: Date | null;

  @ApiProperty({
    type: String,
    enum: ['PENDING', 'SENT', 'FAILED'],
    nullable: true,
    description:
      'Solo en invitaciones: estado del último email con el enlace (PENDING = por enviar o saliendo). null en los miembros o si nunca se encoló',
  })
  emailDelivery!: 'PENDING' | 'SENT' | 'FAILED' | null;
}

export class StaffDirectoryPageDto {
  @ApiProperty({ type: [StaffDirectoryEntryDto] })
  items!: StaffDirectoryEntryDto[];

  @ApiProperty({ description: 'Total de filas que pasan los filtros' })
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}

/** `GET /staff/:userId` — el miembro más su estado, para la vista de perfil. */
export class StaffMemberDetailDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ enum: ClinicRole })
  role!: ClinicRole;

  @ApiProperty({ enum: ['ACTIVE', 'INACTIVE'] })
  status!: 'ACTIVE' | 'INACTIVE';

  @ApiProperty({
    type: [String],
    format: 'uuid',
    nullable: true,
    description:
      'Sedes activas en las que puede trabajar (DX-089). null = todas (sin restricción)',
  })
  locationIds!: string[] | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'DX-048: hasta cuándo no puede iniciar sesión por intentos fallidos (null = sin bloqueo). Siempre null para un miembro desactivado (DX-213). Se quita con POST /staff/:userId/login-unlock.',
  })
  loginBlockedUntil!: Date | null;
}
