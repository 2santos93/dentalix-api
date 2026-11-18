import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  SESSION_IDLE_MAX_MINUTES,
  SESSION_IDLE_MIN_MINUTES,
} from '../../domain/user-sessions';

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

  @ApiPropertyOptional({
    minimum: SESSION_IDLE_MIN_MINUTES,
    maximum: SESSION_IDLE_MAX_MINUTES,
    description:
      'DX-137: minutos sin actividad (por defecto 60) tras los que la web cierra la sesión («Sesión cerrada por inactividad») y /auth/refresh deja de renovarla. Sin indicarlo, se conserva. Auditado (`SESSION_IDLE_POLICY`).',
  })
  @IsOptional()
  @IsInt()
  @Min(SESSION_IDLE_MIN_MINUTES)
  @Max(SESSION_IDLE_MAX_MINUTES)
  sessionIdleMinutes?: number;
}
