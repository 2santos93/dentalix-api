import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength } from 'class-validator';
import { MFA_RESET_REASONS, type MfaResetReason } from '../../domain/user-mfa';
import { SecondFactorDto } from './login-mfa.dto';

export class StaffMfaStatusDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  enabledAt!: Date | null;
}

export class ResetMemberMfaDto extends SecondFactorDto {
  @ApiProperty({ description: 'Tu contraseña actual (re-autenticación).' })
  @IsString()
  @MaxLength(256)
  currentPassword!: string;

  @ApiProperty({ enum: MFA_RESET_REASONS })
  @IsIn(MFA_RESET_REASONS)
  reason!: MfaResetReason;
}
