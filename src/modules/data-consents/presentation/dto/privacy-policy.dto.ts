import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

// Tope generoso: una política real ocupa unas pocas páginas.
const POLICY_TEXT_MAX = 50_000;
const SCOPE_TEXT_MAX = 5_000;

export class UserRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Dra. Laura Gómez' })
  fullName!: string;
}

/** Cuerpo de `POST /privacy-policies`: se publica tal cual, sin borrador. */
export class PublishPrivacyPolicyDto {
  @ApiProperty({
    description: 'Texto completo de la política (aviso de privacidad).',
    minLength: 1,
    maxLength: POLICY_TEXT_MAX,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(POLICY_TEXT_MAX)
  policyText!: string;

  @ApiProperty({
    description: 'Texto de la casilla GENERAL (datos personales).',
    minLength: 1,
    maxLength: SCOPE_TEXT_MAX,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(SCOPE_TEXT_MAX)
  generalText!: string;

  @ApiProperty({
    description:
      'Texto de la casilla SENSITIVE_HEALTH (datos sensibles de salud): lo que el paciente autoriza de forma expresa y separada.',
    minLength: 1,
    maxLength: SCOPE_TEXT_MAX,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(SCOPE_TEXT_MAX)
  sensitiveHealthText!: string;

  @ApiProperty({
    description: 'Texto de la casilla MARKETING (finalidades comerciales).',
    minLength: 1,
    maxLength: SCOPE_TEXT_MAX,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(SCOPE_TEXT_MAX)
  marketingText!: string;
}

export class PrivacyPolicyVersionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 1, description: 'Correlativo por clínica.' })
  version!: number;

  @ApiProperty()
  policyText!: string;

  @ApiProperty()
  generalText!: string;

  @ApiProperty()
  sensitiveHealthText!: string;

  @ApiProperty()
  marketingText!: string;

  @ApiProperty({
    description: 'sha256 (hex) de los cuatro textos tal como se publicaron.',
  })
  contentHash!: string;

  @ApiProperty({ format: 'date-time' })
  publishedAt!: Date;

  @ApiProperty({ type: UserRefDto })
  publishedBy!: UserRefDto;
}

export class PrivacyPoliciesDto {
  @ApiProperty({
    type: PrivacyPolicyVersionDto,
    nullable: true,
    description:
      'Versión vigente (la de mayor número); `null` si la clínica aún no publicó ninguna.',
  })
  current!: PrivacyPolicyVersionDto | null;

  @ApiProperty({
    type: [PrivacyPolicyVersionDto],
    description:
      'Todas las versiones publicadas, de la más reciente a la más antigua.',
  })
  history!: PrivacyPolicyVersionDto[];
}
