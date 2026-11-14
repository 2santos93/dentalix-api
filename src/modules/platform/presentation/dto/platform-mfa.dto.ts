import { ApiProperty } from '@nestjs/swagger';

export class PlatformMfaStatusDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  enabledAt!: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'SEC-008: desde cuándo sirve para el acceso de soporte (alta + espera de seguridad, BREAK_GLASS_MFA_COOLDOWN_MINUTES). null sin MFA.',
  })
  breakGlassAvailableAt!: Date | null;
  @ApiProperty({
    description:
      'DX-021-bis: códigos de recuperación sin usar. 0 si activó el MFA antes de existir: debe generarlos.',
  })
  recoveryCodesRemaining!: number;
}
