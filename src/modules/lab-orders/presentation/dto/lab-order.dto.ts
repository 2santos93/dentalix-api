import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  CANCEL_REASON_MAX,
  CANCEL_REASON_MIN,
  FDI_TOOTH_PATTERN,
  LAB_ORDER_MAX_PAGE_SIZE,
  LAB_ORDER_STATUSES,
  ORDER_DESCRIPTION_MAX,
  ORDER_INSTRUCTIONS_MAX,
  ORDER_MATERIAL_MAX,
  ORDER_SHADE_MAX,
  ORDER_TEETH_MAX,
  type LabOrderStatus,
} from '../../domain/lab-order-rules';

// Orden de laboratorio (DX-017). Fechas prometidas como día civil
// 'AAAA-MM-DD' de la sede; instantes en ISO. Sin tenant, número, profesional
// ni autor: los pone el servidor. `shade` e `instructions` son datos de salud.

const CIVIL_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_EXAMPLE = '2026-11-27';

// ---------------------------------------------------------------------------
// Respuesta
// ---------------------------------------------------------------------------

export class LabOrderPersonDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fullName!: string;
}

export class LabOrderPatientDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'María Rondón' }) fullName!: string;
}

export class LabOrderNamedRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

export class LabOrderServiceRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Corona zirconio' }) name!: string;
  @ApiProperty({ example: 5 }) leadTimeBusinessDays!: number;
}

export class LabOrderProfessionalDto {
  @ApiProperty({ format: 'uuid' }) membershipId!: string;
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() fullName!: string;
}

export class LabOrderPlanItemRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) planId!: string;
  @ApiProperty({ example: '16' }) toothNumber!: string;
  @ApiProperty({ example: 'Corona de zirconio' }) procedureName!: string;
}

export class LabOrderAppointmentRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'date-time' }) start!: Date;
}

export class LabOrderNumberRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 12 }) number!: number;
}

export class LabOrderDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 12, description: 'Correlativo por clínica' })
  number!: number;
  @ApiProperty({
    enum: LAB_ORDER_STATUSES,
    enumName: 'LabOrderStatus',
    description:
      'Derivado de las fechas: anulada → CANCELLED; revisada → CHECKED; recibida → RECEIVED; enviada → SENT; si no, DRAFT.',
  })
  status!: LabOrderStatus;
  @ApiProperty({
    description:
      'Fecha prometida anterior a hoy (día civil de la sede), sin recibir y sin anular',
  })
  overdue!: boolean;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Días naturales de atraso; null si no está atrasada',
  })
  daysOverdue!: number | null;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({ type: LabOrderPatientDto }) patient!: LabOrderPatientDto;
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty({ type: LabOrderNamedRefDto }) location!: LabOrderNamedRefDto;
  @ApiProperty({ type: LabOrderNamedRefDto }) lab!: LabOrderNamedRefDto;
  @ApiProperty({ type: LabOrderServiceRefDto, nullable: true })
  service!: LabOrderServiceRefDto | null;
  @ApiProperty({ type: LabOrderProfessionalDto })
  professional!: LabOrderProfessionalDto;
  @ApiProperty({ example: 'Corona de zirconio' }) description!: string;
  @ApiProperty({ type: [String], example: ['16'] }) toothNumbers!: string[];
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'A2',
    description: 'Color/tono. Dato de salud: null para recepción.',
  })
  shade!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Zirconio monolítico',
    description: 'null para recepción.',
  })
  material!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Dato de salud: null para recepción.',
  })
  instructions!: string | null;
  @ApiProperty({
    description:
      'true si color, material e instrucciones se ocultaron por el rol',
  })
  clinicalRedacted!: boolean;
  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: DAY_EXAMPLE,
  })
  dueOn!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  sentAt!: Date | null;
  @ApiProperty({ type: LabOrderPersonDto, nullable: true })
  sentBy!: LabOrderPersonDto | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  receivedAt!: Date | null;
  @ApiProperty({ type: LabOrderPersonDto, nullable: true })
  receivedBy!: LabOrderPersonDto | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  checkedAt!: Date | null;
  @ApiProperty({ type: LabOrderPersonDto, nullable: true })
  checkedBy!: LabOrderPersonDto | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt!: Date | null;
  @ApiProperty({ type: LabOrderPersonDto, nullable: true })
  cancelledBy!: LabOrderPersonDto | null;
  @ApiProperty({ type: String, nullable: true }) cancelReason!: string | null;
  @ApiProperty({ type: LabOrderPlanItemRefDto, nullable: true })
  treatmentPlanItem!: LabOrderPlanItemRefDto | null;
  @ApiProperty({ type: LabOrderAppointmentRefDto, nullable: true })
  appointment!: LabOrderAppointmentRefDto | null;
  @ApiProperty({
    type: LabOrderNumberRefDto,
    nullable: true,
    description: 'La orden anterior que esta corrige',
  })
  replacesOrder!: LabOrderNumberRefDto | null;
  @ApiProperty({
    type: [LabOrderNumberRefDto],
    description: 'Órdenes nuevas que corrigen esta',
  })
  replacedBy!: LabOrderNumberRefDto[];
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: LabOrderPersonDto }) createdBy!: LabOrderPersonDto;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: Date;
}

export class LabOrderPageDto {
  @ApiProperty({ type: [LabOrderDto] }) items!: LabOrderDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}

export class DueDateSuggestionDto {
  @ApiProperty({ format: 'date', example: DAY_EXAMPLE }) dueOn!: string;
  @ApiProperty({ format: 'date', example: '2026-11-20' }) from!: string;
  @ApiProperty({ example: 5 }) leadTimeBusinessDays!: number;
}

export class LabOrderPrintClinicDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) legalName!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Nombre del identificador fiscal de la clínica',
  })
  taxIdLabel!: string | null;
  @ApiProperty({ type: String, nullable: true })
  taxId!: string | null;
  @ApiProperty({ type: String, nullable: true }) phone!: string | null;
  @ApiProperty({ type: String, nullable: true }) email!: string | null;
  @ApiProperty({ type: String, nullable: true }) logoUrl!: string | null;
}

export class LabOrderPrintLocationDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) address!: string | null;
  @ApiProperty({ type: String, nullable: true }) phone!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Registro sanitario de la sede, solo si la sede lo muestra',
  })
  healthRegistrationNumber!: string | null;
}

export class LabOrderPrintProfessionalDto {
  @ApiProperty() fullName!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Nº de registro profesional (ClinicMembership.professionalLicense)',
  })
  license!: string | null;
  @ApiProperty({ type: String, nullable: true }) specialty!: string | null;
}

export class LabOrderPrintPatientDto {
  @ApiProperty() fullName!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: '«{nombre del tipo} {número}» o null sin número',
  })
  document!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  birthDate!: string | null;
  @ApiProperty({ type: Number, nullable: true }) ageYears!: number | null;
}

export class LabOrderPrintDto {
  @ApiProperty({
    type: LabOrderDto,
    description: 'La orden completa (sin redactar)',
  })
  order!: LabOrderDto;
  @ApiProperty({ type: LabOrderPrintClinicDto })
  clinic!: LabOrderPrintClinicDto;
  @ApiProperty({ type: LabOrderPrintLocationDto })
  location!: LabOrderPrintLocationDto;
  @ApiProperty({ type: LabOrderPrintProfessionalDto })
  professional!: LabOrderPrintProfessionalDto;
  @ApiProperty({ type: LabOrderPrintPatientDto })
  patient!: LabOrderPrintPatientDto;
  @ApiProperty({ type: String, format: 'date-time' }) printedAt!: Date;
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export class CreateLabOrderDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', { message: 'El laboratorio debe ser un identificador válido' })
  labId!: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('all', { message: 'El servicio debe ser un identificador válido' })
  serviceId?: string | null;

  @ApiProperty({
    maxLength: ORDER_DESCRIPTION_MAX,
    example: 'Corona de zirconio',
  })
  @IsString({ message: 'La descripción del trabajo debe ser un texto' })
  @IsNotEmpty({ message: 'Describe el trabajo que se encarga al laboratorio' })
  @MaxLength(ORDER_DESCRIPTION_MAX, {
    message: `La descripción admite hasta ${ORDER_DESCRIPTION_MAX} caracteres`,
  })
  description!: string;

  @ApiPropertyOptional({
    type: [String],
    maxItems: ORDER_TEETH_MAX,
    example: ['16'],
  })
  @IsOptional()
  @IsArray({ message: 'Los dientes deben ser una lista' })
  @ArrayMaxSize(ORDER_TEETH_MAX, {
    message: `Indica como mucho ${ORDER_TEETH_MAX} dientes`,
  })
  @IsString({ each: true, message: 'Cada diente debe ser un texto' })
  @Matches(FDI_TOOTH_PATTERN, {
    each: true,
    message: 'Cada diente debe ser un número FDI válido (11–48 o 51–85)',
  })
  toothNumbers?: string[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: ORDER_SHADE_MAX,
    example: 'A2',
  })
  @IsOptional()
  @IsString({ message: 'El color debe ser un texto' })
  @MaxLength(ORDER_SHADE_MAX, {
    message: `El color admite hasta ${ORDER_SHADE_MAX} caracteres`,
  })
  shade?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: ORDER_MATERIAL_MAX,
  })
  @IsOptional()
  @IsString({ message: 'El material debe ser un texto' })
  @MaxLength(ORDER_MATERIAL_MAX, {
    message: `El material admite hasta ${ORDER_MATERIAL_MAX} caracteres`,
  })
  material?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: ORDER_INSTRUCTIONS_MAX,
  })
  @IsOptional()
  @IsString({ message: 'Las instrucciones deben ser un texto' })
  @MaxLength(ORDER_INSTRUCTIONS_MAX, {
    message: `Las instrucciones admiten hasta ${ORDER_INSTRUCTIONS_MAX} caracteres`,
  })
  instructions?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    nullable: true,
    example: DAY_EXAMPLE,
    description:
      'Fecha prometida. Sin ella y con servicio, la sugerida desde hoy en días hábiles de la sede.',
  })
  @IsOptional()
  @IsString({ message: 'La fecha prometida debe ser una fecha AAAA-MM-DD' })
  @Matches(CIVIL_DAY, {
    message: 'La fecha prometida debe ser una fecha AAAA-MM-DD',
  })
  dueOn?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('all', {
    message: 'El ítem del plan debe ser un identificador válido',
  })
  treatmentPlanItemId?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Cita de colocación (de este paciente)',
  })
  @IsOptional()
  @IsUUID('all', { message: 'La cita debe ser un identificador válido' })
  appointmentId?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Orden anterior (de este paciente) que esta corrige',
  })
  @IsOptional()
  @IsUUID('all', {
    message: 'La orden que corriges debe ser un identificador válido',
  })
  replacesOrderId?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Sede de la orden. Sin ella, la sede activa (X-Location-Id).',
  })
  @IsOptional()
  @IsUUID('all', { message: 'La sede debe ser un identificador válido' })
  locationId?: string;
}

export class UpdateLabOrderDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: 'El laboratorio debe ser un identificador válido' })
  labId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('all', { message: 'El servicio debe ser un identificador válido' })
  serviceId?: string | null;

  @ApiPropertyOptional({ maxLength: ORDER_DESCRIPTION_MAX })
  @IsOptional()
  @IsString({ message: 'La descripción del trabajo debe ser un texto' })
  @IsNotEmpty({ message: 'La descripción del trabajo no puede quedar vacía' })
  @MaxLength(ORDER_DESCRIPTION_MAX, {
    message: `La descripción admite hasta ${ORDER_DESCRIPTION_MAX} caracteres`,
  })
  description?: string;

  @ApiPropertyOptional({ type: [String], maxItems: ORDER_TEETH_MAX })
  @IsOptional()
  @IsArray({ message: 'Los dientes deben ser una lista' })
  @ArrayMaxSize(ORDER_TEETH_MAX, {
    message: `Indica como mucho ${ORDER_TEETH_MAX} dientes`,
  })
  @IsString({ each: true, message: 'Cada diente debe ser un texto' })
  @Matches(FDI_TOOTH_PATTERN, {
    each: true,
    message: 'Cada diente debe ser un número FDI válido (11–48 o 51–85)',
  })
  toothNumbers?: string[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: ORDER_SHADE_MAX,
  })
  @IsOptional()
  @IsString({ message: 'El color debe ser un texto' })
  @MaxLength(ORDER_SHADE_MAX, {
    message: `El color admite hasta ${ORDER_SHADE_MAX} caracteres`,
  })
  shade?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: ORDER_MATERIAL_MAX,
  })
  @IsOptional()
  @IsString({ message: 'El material debe ser un texto' })
  @MaxLength(ORDER_MATERIAL_MAX, {
    message: `El material admite hasta ${ORDER_MATERIAL_MAX} caracteres`,
  })
  material?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: ORDER_INSTRUCTIONS_MAX,
  })
  @IsOptional()
  @IsString({ message: 'Las instrucciones deben ser un texto' })
  @MaxLength(ORDER_INSTRUCTIONS_MAX, {
    message: `Las instrucciones admiten hasta ${ORDER_INSTRUCTIONS_MAX} caracteres`,
  })
  instructions?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true })
  @IsOptional()
  @IsString({ message: 'La fecha prometida debe ser una fecha AAAA-MM-DD' })
  @Matches(CIVIL_DAY, {
    message: 'La fecha prometida debe ser una fecha AAAA-MM-DD',
  })
  dueOn?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('all', {
    message: 'El ítem del plan debe ser un identificador válido',
  })
  treatmentPlanItemId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('all', { message: 'La cita debe ser un identificador válido' })
  appointmentId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('all', {
    message: 'La orden que corriges debe ser un identificador válido',
  })
  replacesOrderId?: string | null;
}

export class SendLabOrderDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date',
    nullable: true,
    description:
      'Fecha prometida. Sin ella y con servicio: la sugerida desde el día del envío (si la orden no tenía una puesta a mano).',
  })
  @IsOptional()
  @IsString({ message: 'La fecha prometida debe ser una fecha AAAA-MM-DD' })
  @Matches(CIVIL_DAY, {
    message: 'La fecha prometida debe ser una fecha AAAA-MM-DD',
  })
  dueOn?: string | null;
}

export class CancelLabOrderDto {
  @ApiProperty({ minLength: CANCEL_REASON_MIN, maxLength: CANCEL_REASON_MAX })
  @IsString({ message: 'El motivo de la anulación debe ser un texto' })
  @MinLength(CANCEL_REASON_MIN, {
    message: `Indica el motivo de la anulación (de ${CANCEL_REASON_MIN} a ${CANCEL_REASON_MAX} caracteres)`,
  })
  @MaxLength(CANCEL_REASON_MAX, {
    message: `El motivo admite hasta ${CANCEL_REASON_MAX} caracteres`,
  })
  reason!: string;
}

export class PatientLabOrdersQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'La página debe ser un número entero' })
  @Min(1, { message: 'La página empieza en 1' })
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: LAB_ORDER_MAX_PAGE_SIZE,
    default: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'El tamaño de página debe ser un número entero' })
  @Min(1, {
    message: `El tamaño de página va de 1 a ${LAB_ORDER_MAX_PAGE_SIZE}`,
  })
  @Max(LAB_ORDER_MAX_PAGE_SIZE, {
    message: `El tamaño de página va de 1 a ${LAB_ORDER_MAX_PAGE_SIZE}`,
  })
  pageSize?: number;
}

export class LabOrdersQueryDto extends PatientLabOrdersQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Sede. Sin ella, la sede activa (X-Location-Id o la principal).',
  })
  @IsOptional()
  @IsUUID('all', { message: 'La sede debe ser un identificador válido' })
  locationId?: string;

  @ApiPropertyOptional({
    enum: LAB_ORDER_STATUSES,
    enumName: 'LabOrderStatus',
    isArray: true,
    description: 'Uno o varios (status=DRAFT&status=SENT). Sin él, todos.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === undefined ? undefined : Array.isArray(value) ? value : [value],
  )
  @IsArray({ message: 'El estado debe ser una lista' })
  @ArrayMaxSize(LAB_ORDER_STATUSES.length, {
    message: 'Demasiados estados en el filtro',
  })
  @IsIn(LAB_ORDER_STATUSES, {
    each: true,
    message: 'El estado debe ser DRAFT, SENT, RECEIVED, CHECKED o CANCELLED',
  })
  status?: LabOrderStatus[];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: 'El laboratorio debe ser un identificador válido' })
  labId?: string;

  @ApiPropertyOptional({
    format: 'date',
    description: 'Fecha prometida desde (incluida)',
  })
  @IsOptional()
  @IsString({ message: 'La fecha «desde» debe ser una fecha AAAA-MM-DD' })
  @Matches(CIVIL_DAY, {
    message: 'La fecha «desde» debe ser una fecha AAAA-MM-DD',
  })
  from?: string;

  @ApiPropertyOptional({
    format: 'date',
    description: 'Fecha prometida hasta (incluida)',
  })
  @IsOptional()
  @IsString({ message: 'La fecha «hasta» debe ser una fecha AAAA-MM-DD' })
  @Matches(CIVIL_DAY, {
    message: 'La fecha «hasta» debe ser una fecha AAAA-MM-DD',
  })
  to?: string;

  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description:
      'true = solo atrasadas (fecha prometida vencida, sin recibir ni anular)',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean({ message: 'overdue debe ser true o false' })
  overdue?: boolean;
}

export class DueDateSuggestionQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', { message: 'El servicio debe ser un identificador válido' })
  serviceId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Sede. Sin ella, la activa.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'La sede debe ser un identificador válido' })
  locationId?: string;

  @ApiPropertyOptional({
    format: 'date',
    description: 'Día de inicio (por defecto, hoy en la sede)',
  })
  @IsOptional()
  @IsString({ message: 'La fecha de inicio debe ser una fecha AAAA-MM-DD' })
  @Matches(CIVIL_DAY, {
    message: 'La fecha de inicio debe ser una fecha AAAA-MM-DD',
  })
  from?: string;
}
