import { ApiProperty } from '@nestjs/swagger';
import { ClinicRole, ExtraPermission } from '@prisma/client';

export class MyProfileMembershipDto {
  @ApiProperty() tenantId!: string;
  @ApiProperty() clinicName!: string;
  @ApiProperty({ enum: ClinicRole }) role!: ClinicRole;
}

export class MyProfileDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'URL absoluta del avatar, calculada al responder (en la BD solo la clave)',
  })
  avatarUrl!: string | null;
  @ApiProperty({ type: String, nullable: true }) emailVerifiedAt!:
    string | null;
  @ApiProperty({ type: [MyProfileMembershipDto] })
  memberships!: MyProfileMembershipDto[];
  @ApiProperty({
    enum: ExtraPermission,
    enumName: 'ExtraPermission',
    isArray: true,
    description:
      'DX-090: lo que puede hacer en la clínica de la sesión: los permisos de serie de su rol más los extra concedidos. Solo decide qué pinta la web; la frontera es cada ruta.',
  })
  effectivePermissions!: ExtraPermission[];
  @ApiProperty({
    minimum: 15,
    maximum: 240,
    description:
      'DX-137: minutos sin actividad tras los que la web cierra la sesión de esta clínica («Sesión cerrada por inactividad»).',
  })
  sessionIdleMinutes!: number;
}
