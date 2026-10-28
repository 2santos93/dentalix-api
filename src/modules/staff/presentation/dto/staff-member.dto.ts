import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';

// Response shape for GET /staff — documents the `{userId, fullName, email, role}`
// contract for Swagger. The use case/repository already return values
// shaped exactly like this (StaffMember entity); this class exists purely
// for `@ApiProperty` documentation, not for input validation.
export class StaffMemberDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ enum: ClinicRole })
  role!: ClinicRole;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Nº de registro profesional del miembro (DX-013). Solo en el perfil y en la respuesta del PATCH.',
  })
  professionalLicense?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Especialidad del profesional en esta clínica (DX-324). Solo en el perfil y en la respuesta del PATCH.',
  })
  professionalSpecialty?: string | null;

  // Opcional en el contrato porque el DTO también describe el PATCH, que no lo envía; GET /staff siempre incluye la clave.
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    nullable: true,
    description:
      'Sedes activas en las que puede trabajar (DX-089). null = todas (sin restricción). Solo en GET /staff y en el perfil.',
  })
  locationIds?: string[] | null;
}
