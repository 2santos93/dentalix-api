import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { DataConsentChannel, DataConsentScope } from '@prisma/client';
import { UserRefDto } from './privacy-policy.dto';

export class ConsentDecisionDto {
  @ApiProperty({ enum: DataConsentScope, enumName: 'DataConsentScope' })
  @IsEnum(DataConsentScope)
  scope!: DataConsentScope;

  @ApiProperty({
    description: '`true` = autoriza; `false` = no autoriza o revoca.',
  })
  @IsBoolean()
  granted!: boolean;
}

/**
 * Decisiones EXPLÍCITAS del paciente sobre la versión vigente de la política.
 * Lo que no viene aquí no se registra: el silencio no es autorización.
 */
export class RecordDataConsentsDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Versión de la política que se le mostró al paciente. Debe ser la vigente (409 si cambió).',
  })
  @IsUUID()
  policyVersionId!: string;

  @ApiProperty({ type: [ConsentDecisionDto], minItems: 1, maxItems: 3 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ArrayUnique((d: ConsentDecisionDto) => d.scope, {
    message: 'Cada tipo de autorización solo puede aparecer una vez.',
  })
  @ValidateNested({ each: true })
  @Type(() => ConsentDecisionDto)
  decisions!: ConsentDecisionDto[];
}

export class PolicyVersionRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 1 })
  version!: number;
}

export class DataConsentRecordDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ enum: DataConsentScope, enumName: 'DataConsentScope' })
  scope!: DataConsentScope;

  @ApiProperty()
  granted!: boolean;

  @ApiProperty({
    enum: DataConsentChannel,
    enumName: 'DataConsentChannel',
    description:
      'IN_PERSON = registrado en la clínica con el texto vigente. LEGACY = heredado del booleano anterior, sin texto versionado.',
  })
  channel!: DataConsentChannel;

  @ApiProperty({
    type: PolicyVersionRefDto,
    nullable: true,
    description: '`null` solo en filas LEGACY.',
  })
  policyVersion!: PolicyVersionRefDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Etiqueta de versión del registro heredado (solo LEGACY).',
  })
  legacyPolicyVersion!: string | null;

  @ApiProperty({ format: 'date-time', description: 'Hora del servidor.' })
  recordedAt!: Date;

  @ApiProperty({
    type: UserRefDto,
    nullable: true,
    description: '`null` solo en filas LEGACY migradas.',
  })
  recordedBy!: UserRefDto | null;

  @ApiProperty({ type: String, nullable: true })
  ipAddress!: string | null;

  @ApiProperty({ type: String, nullable: true })
  userAgent!: string | null;
}

export class ScopeConsentStatusDto {
  @ApiProperty({ enum: DataConsentScope, enumName: 'DataConsentScope' })
  scope!: DataConsentScope;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: '`null` = el paciente aún no ha decidido sobre este scope.',
  })
  granted!: boolean | null;

  @ApiProperty({ type: DataConsentRecordDto, nullable: true })
  latest!: DataConsentRecordDto | null;
}

export class PatientDataConsentsDto {
  @ApiProperty({
    type: [ScopeConsentStatusDto],
    description:
      'Estado vigente: un elemento por scope (GENERAL, SENSITIVE_HEALTH, MARKETING), la última fila de cada uno.',
  })
  current!: ScopeConsentStatusDto[];

  @ApiProperty({
    type: [DataConsentRecordDto],
    description: 'Todas las filas, de la más reciente a la más antigua.',
  })
  history!: DataConsentRecordDto[];
}
