import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SecurityPolicyDto {
  @ApiProperty({
    description:
      'DX-021: exige la verificación en dos pasos a los ADMIN de la clínica. Quien no la tenga pasa por el alta forzada en su próximo inicio de sesión.',
  })
  @IsBoolean()
  requireAdminMfa!: boolean;
}
