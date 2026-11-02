import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class SecurityPolicyDto {
  @ApiProperty({
    description:
      'DX-021: exige la verificación en dos pasos a los ADMIN de la clínica. Quien no la tenga pasa por el alta forzada en su próximo inicio de sesión.',
  })
  @IsBoolean()
  requireAdminMfa!: boolean;

  @ApiPropertyOptional({
    description:
      'DX-021-bis: la exige a todos los miembros (implica `requireAdminMfa`). Sin indicarlo, se conserva.',
  })
  @IsOptional()
  @IsBoolean()
  requireAllMfa?: boolean;
}
