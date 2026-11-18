import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { TextMaxLength } from '../../../../shared/validation/input-limits';
import {
  LEAD_BOARD_MAX_PER_STAGE,
  LEAD_DEFAULT_PAGE_SIZE,
  LEAD_MAX_PAGE_SIZE,
} from '../../application/leads.use-cases';
import {
  LEAD_CHANNELS,
  LEAD_NAME_MAX,
  LEAD_NEXT_ACTION_NOTE_MAX,
  LEAD_NOTE_MAX,
  LEAD_PHONE_INPUT_MAX,
  LEAD_REASON_KINDS,
  LEAD_REASON_MAX,
  LEAD_RETENTION_MONTHS_MAX,
  LEAD_RETENTION_MONTHS_MIN,
  LEAD_STAGES,
  type LeadChannelCode,
  type LeadReasonKindCode,
  type LeadStageCode,
} from '../../domain/lead-rules';

const HEALTH_HINT =
  'Solo datos comerciales: nunca datos de salud (síntomas, diagnósticos, medicación).';

// ---------------------------------------------------------------------------
// Entradas
// ---------------------------------------------------------------------------

export class CreateLeadDto {
  @ApiProperty({ maxLength: LEAD_NAME_MAX })
  @IsString({ message: 'Escribe el nombre del prospecto.' })
  @TextMaxLength(LEAD_NAME_MAX)
  fullName!: string;

  @ApiProperty({
    maxLength: LEAD_PHONE_INPUT_MAX,
    description:
      'En cualquier formato; sin «+», con el prefijo de la sede. Se guarda en E.164. Si ya es de un paciente o de otro prospecto: 409 `LEAD_PHONE_TAKEN` con `existing`.',
  })
  @IsString({ message: 'Escribe el teléfono.' })
  @TextMaxLength(LEAD_PHONE_INPUT_MAX)
  phone!: string;

  @ApiProperty({ enum: LEAD_CHANNELS, enumName: 'LeadChannel' })
  @IsIn(LEAD_CHANNELS, { message: 'El canal no es válido.' })
  channel!: LeadChannelCode;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: LEAD_REASON_MAX,
    description: 'Motivo de interés del catálogo (predefinido o propio).',
  })
  @IsOptional()
  @IsString()
  @TextMaxLength(LEAD_REASON_MAX)
  interestReason?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Sede del prospecto (403 si no es de las del usuario). Sin ella, la sede activa o la primera permitida.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Responsable (ADMIN o RECEPTION de la clínica). Sin él, quien lo da de alta; `null`, sin responsable.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID('all', { message: 'ownerId debe ser un UUID.' })
  ownerId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsISO8601(
    { strict: true },
    { message: 'nextActionAt debe ser una fecha ISO.' },
  )
  nextActionAt?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: LEAD_NEXT_ACTION_NOTE_MAX,
    description: `Qué hacer en la próxima acción. ${HEALTH_HINT}`,
  })
  @IsOptional()
  @IsString()
  @TextMaxLength(LEAD_NEXT_ACTION_NOTE_MAX)
  nextActionNote?: string | null;
}

export class UpdateLeadDto {
  @ApiPropertyOptional({ maxLength: LEAD_NAME_MAX })
  @IsOptional()
  @IsString()
  @TextMaxLength(LEAD_NAME_MAX)
  fullName?: string;

  @ApiPropertyOptional({ maxLength: LEAD_PHONE_INPUT_MAX })
  @IsOptional()
  @IsString()
  @TextMaxLength(LEAD_PHONE_INPUT_MAX)
  phone?: string;

  @ApiPropertyOptional({ enum: LEAD_CHANNELS, enumName: 'LeadChannel' })
  @IsOptional()
  @IsIn(LEAD_CHANNELS, { message: 'El canal no es válido.' })
  channel?: LeadChannelCode;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: LEAD_REASON_MAX,
  })
  @IsOptional()
  @IsString()
  @TextMaxLength(LEAD_REASON_MAX)
  interestReason?: string | null;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID('all', { message: 'ownerId debe ser un UUID.' })
  ownerId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsISO8601(
    { strict: true },
    { message: 'nextActionAt debe ser una fecha ISO.' },
  )
  nextActionAt?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: LEAD_NEXT_ACTION_NOTE_MAX,
  })
  @IsOptional()
  @IsString()
  @TextMaxLength(LEAD_NEXT_ACTION_NOTE_MAX)
  nextActionNote?: string | null;
}

export class ChangeLeadStageDto {
  @ApiProperty({
    enum: LEAD_STAGES,
    enumName: 'LeadStage',
    description:
      'NEW ↔ CONTACTED; NEW/CONTACTED/SCHEDULED → LOST (con motivo); LOST → NEW/CONTACTED (reabrir); SCHEDULED → CONTACTED. SCHEDULED y ATTENDED solo por la cita (409).',
  })
  @IsIn(LEAD_STAGES, { message: 'La etapa no es válida.' })
  stage!: LeadStageCode;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: LEAD_REASON_MAX,
    description: 'Motivo de pérdida del catálogo: obligatorio con LOST.',
  })
  @IsOptional()
  @IsString()
  @TextMaxLength(LEAD_REASON_MAX)
  lostReason?: string | null;
}

export class AddLeadNoteDto {
  @ApiProperty({ maxLength: LEAD_NOTE_MAX, description: HEALTH_HINT })
  @IsString({ message: 'Escribe la nota.' })
  @TextMaxLength(LEAD_NOTE_MAX)
  body!: string;
}

export class ConvertLeadDto {
  @ApiPropertyOptional({
    maxLength: LEAD_NAME_MAX,
    description:
      'Nombre de la ficha. Sin él, la primera palabra del prospecto.',
  })
  @IsOptional()
  @IsString()
  @TextMaxLength(LEAD_NAME_MAX)
  firstName?: string;

  @ApiPropertyOptional({
    maxLength: LEAD_NAME_MAX,
    description:
      'Apellido de la ficha. Sin él, el resto del nombre del prospecto.',
  })
  @IsOptional()
  @IsString()
  @TextMaxLength(LEAD_NAME_MAX)
  lastName?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Con varios pacientes con ese teléfono (409 `LEAD_AMBIGUOUS_PATIENTS`), el elegido de entre ellos.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'patientId debe ser un UUID.' })
  patientId?: string;
}

export class LeadScopeQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo esta sede (403 si no es de las del usuario). Sin ella, la sede activa (X-Location-Id) o todas las que ve el usuario.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;
}

export class LeadFilterQueryDto extends LeadScopeQueryDto {
  @ApiPropertyOptional({ enum: LEAD_CHANNELS, enumName: 'LeadChannel' })
  @IsOptional()
  @IsIn(LEAD_CHANNELS, { message: 'El canal no es válido.' })
  channel?: LeadChannelCode;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: 'ownerId debe ser un UUID.' })
  ownerId?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Solo los que no tienen responsable (la fila «Sin responsable» del informe). Se ignora con `ownerId`.',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unowned?: boolean;

  @ApiPropertyOptional({
    maxLength: LEAD_NAME_MAX,
    description: 'Nombre (sin tildes ni mayúsculas) o 3+ dígitos del teléfono.',
  })
  @IsOptional()
  @IsString()
  @TextMaxLength(LEAD_NAME_MAX)
  q?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Alta desde este instante (incluido).',
  })
  @IsOptional()
  @IsISO8601(
    { strict: true },
    { message: 'createdFrom debe ser una fecha ISO.' },
  )
  createdFrom?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Alta hasta este instante (excluido).',
  })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'createdTo debe ser una fecha ISO.' })
  createdTo?: string;
}

export class LeadListQueryDto extends LeadFilterQueryDto {
  @ApiPropertyOptional({ enum: LEAD_STAGES, enumName: 'LeadStage' })
  @IsOptional()
  @IsIn(LEAD_STAGES, { message: 'La etapa no es válida.' })
  stage?: LeadStageCode;

  @ApiPropertyOptional({
    enum: ['SCHEDULED', 'ATTENDED'],
    description:
      'Los que llegaron a tener cita (`SCHEDULED`) o asistieron (`ATTENDED`), aunque luego cambiaran de etapa: las cifras del informe.',
  })
  @IsOptional()
  @IsIn(['SCHEDULED', 'ATTENDED'], {
    message: 'reached debe ser «SCHEDULED» o «ATTENDED».',
  })
  reached?: 'SCHEDULED' | 'ATTENDED';

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Solo los «sin contactar hace más de 24 h» (Mi día).',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  stale?: boolean;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'La página debe ser un número entero' })
  @Min(1, { message: 'La página empieza en 1' })
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: LEAD_MAX_PAGE_SIZE,
    default: LEAD_DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'El tamaño de página debe ser un número entero' })
  @Min(1, { message: `El tamaño de página va de 1 a ${LEAD_MAX_PAGE_SIZE}` })
  @Max(LEAD_MAX_PAGE_SIZE, {
    message: `El tamaño de página va de 1 a ${LEAD_MAX_PAGE_SIZE}`,
  })
  pageSize?: number;
}

export class LeadBoardQueryDto extends LeadFilterQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: LEAD_BOARD_MAX_PER_STAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'perStage debe ser un número entero' })
  @Min(1, { message: `perStage va de 1 a ${LEAD_BOARD_MAX_PER_STAGE}` })
  @Max(LEAD_BOARD_MAX_PER_STAGE, {
    message: `perStage va de 1 a ${LEAD_BOARD_MAX_PER_STAGE}`,
  })
  perStage?: number;
}

export class LeadReportQueryDto extends LeadScopeQueryDto {
  @ApiProperty({ format: 'date-time', description: 'Alta desde (incluido).' })
  @IsISO8601({ strict: true }, { message: 'from debe ser una fecha ISO.' })
  from!: string;

  @ApiProperty({ format: 'date-time', description: 'Alta hasta (excluido).' })
  @IsISO8601({ strict: true }, { message: 'to debe ser una fecha ISO.' })
  to!: string;
}

export class LeadReasonsQueryDto {
  @ApiPropertyOptional({ enum: LEAD_REASON_KINDS, enumName: 'LeadReasonKind' })
  @IsOptional()
  @IsIn(LEAD_REASON_KINDS, { message: 'kind debe ser INTEREST o LOSS.' })
  kind?: LeadReasonKindCode;
}

export class CreateLeadReasonDto {
  @ApiProperty({ enum: LEAD_REASON_KINDS, enumName: 'LeadReasonKind' })
  @IsIn(LEAD_REASON_KINDS, { message: 'kind debe ser INTEREST o LOSS.' })
  kind!: LeadReasonKindCode;

  @ApiProperty({ minLength: 2, maxLength: LEAD_REASON_MAX })
  @IsString({ message: 'Escribe el motivo.' })
  @TextMaxLength(LEAD_REASON_MAX)
  name!: string;
}

export class UpdateLeadSettingsDto {
  @ApiProperty({
    minimum: LEAD_RETENTION_MONTHS_MIN,
    maximum: LEAD_RETENTION_MONTHS_MAX,
    description: 'Meses tras los que un prospecto PERDIDO se anonimiza.',
  })
  @Type(() => Number)
  @IsInt({ message: 'Los meses deben ser un número entero.' })
  @Min(LEAD_RETENTION_MONTHS_MIN, {
    message: `Los meses van de ${LEAD_RETENTION_MONTHS_MIN} a ${LEAD_RETENTION_MONTHS_MAX}.`,
  })
  @Max(LEAD_RETENTION_MONTHS_MAX, {
    message: `Los meses van de ${LEAD_RETENTION_MONTHS_MIN} a ${LEAD_RETENTION_MONTHS_MAX}.`,
  })
  lostRetentionMonths!: number;
}

// ---------------------------------------------------------------------------
// Salidas
// ---------------------------------------------------------------------------

export class LeadDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty() locationName!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ type: String, nullable: true }) phone!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Dígitos para wa.me (el E.164 sin «+»).',
  })
  whatsAppDigits!: string | null;
  @ApiProperty({ enum: LEAD_CHANNELS, enumName: 'LeadChannel' })
  channel!: LeadChannelCode;
  @ApiProperty({ type: String, nullable: true }) interestReason!: string | null;
  @ApiProperty({ enum: LEAD_STAGES, enumName: 'LeadStage' })
  stage!: LeadStageCode;
  @ApiProperty({ type: String, nullable: true }) lostReason!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  ownerId!: string | null;
  @ApiProperty({ type: String, nullable: true }) ownerName!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  nextActionAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) nextActionNote!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastContactAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  scheduledAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  attendedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lostAt!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  convertedPatientId!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  convertedAt!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  firstAppointmentId!: string | null;
  @ApiProperty() anonymized!: boolean;
  @ApiProperty({ description: '«Sin contactar hace más de 24 h».' })
  stale!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class LeadNoteDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() body!: string;
  @ApiProperty({ format: 'uuid' }) authorId!: string;
  @ApiProperty({ type: String, nullable: true }) authorName!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class LeadDetailDto extends LeadDto {
  @ApiProperty({ type: [LeadNoteDto], description: 'Más recientes primero.' })
  notes!: LeadNoteDto[];
}

export class LeadListDto {
  @ApiProperty({ type: [LeadDto] }) items!: LeadDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}

export class LeadBoardColumnDto {
  @ApiProperty({ enum: LEAD_STAGES, enumName: 'LeadStage' })
  stage!: LeadStageCode;
  @ApiProperty() total!: number;
  @ApiProperty({ type: [LeadDto] }) items!: LeadDto[];
}

export class LeadBoardDto {
  @ApiProperty({ type: [LeadBoardColumnDto] })
  columns!: LeadBoardColumnDto[];
}

export class LeadCountDto {
  @ApiProperty({ description: 'Abiertos (NEW y CONTACTED).' }) open!: number;
  @ApiProperty({ description: '«Sin contactar hace más de 24 h».' })
  stale!: number;
}

export class LeadReportLineDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Canal o id del responsable (null = sin responsable / total).',
  })
  key!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Nombre del responsable.',
  })
  label!: string | null;
  @ApiProperty() leads!: number;
  @ApiProperty({ description: 'Llegaron a tener cita.' }) scheduled!: number;
  @ApiProperty({ description: 'Asistieron.' }) attended!: number;
  @ApiProperty({ description: 'Con cita / prospectos (0..1).' })
  scheduledRate!: number;
  @ApiProperty({ description: 'Asistieron / con cita (0..1).' })
  attendedRate!: number;
  @ApiProperty({ description: 'Asistieron / prospectos (0..1).' })
  conversionRate!: number;
}

export class LeadReportDto {
  @ApiProperty({ format: 'date-time' }) from!: string;
  @ApiProperty({ format: 'date-time' }) to!: string;
  @ApiProperty({ type: LeadReportLineDto }) totals!: LeadReportLineDto;
  @ApiProperty({ type: [LeadReportLineDto] }) byChannel!: LeadReportLineDto[];
  @ApiProperty({ type: [LeadReportLineDto] }) byOwner!: LeadReportLineDto[];
}

export class ConvertLeadResultDto {
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({ description: 'Se creó la ficha ahora.' }) created!: boolean;
  @ApiProperty({ description: 'Se enlazó a un paciente con ese teléfono.' })
  linked!: boolean;
  @ApiProperty({ type: LeadDto }) lead!: LeadDto;
}

export class LeadOwnerDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ enum: ['ADMIN', 'RECEPTION'] }) role!: string;
}

export class LeadReasonDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null en los predefinidos.',
  })
  id!: string | null;
  @ApiProperty({ enum: LEAD_REASON_KINDS, enumName: 'LeadReasonKind' })
  kind!: LeadReasonKindCode;
  @ApiProperty() name!: string;
  @ApiProperty() predefined!: boolean;
}

export class LeadSettingsDto {
  @ApiProperty({
    minimum: LEAD_RETENTION_MONTHS_MIN,
    maximum: LEAD_RETENTION_MONTHS_MAX,
  })
  lostRetentionMonths!: number;
}
