import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  OnlineBookingMode,
  OnlineBookingPatientKind,
  OnlineBookingStatus,
} from '@prisma/client';
import {
  ONLINE_ADVANCE_MAX_DAYS,
  ONLINE_DURATION_MAX,
  ONLINE_DURATION_MIN,
  ONLINE_LEAD_MAX_MINUTES,
  ONLINE_MAX_IDS,
  ONLINE_SETTINGS_MESSAGES,
  ONLINE_STEP_MAX,
  ONLINE_STEP_MIN,
} from '../../domain/online-booking-settings';
import { MAX_ONLINE_SLOT_DAYS } from '../../domain/online-slots';

const BAD =
  'No pudimos procesar tu reserva. Revisa los datos y vuelve a intentarlo.';

// ---------------------------------------------------------------------------
// Personal: ajustes y tipos
// ---------------------------------------------------------------------------

export class UpdateOnlineBookingSettingsDto {
  @ApiProperty({
    description:
      'Activa la página pública /reservar (por defecto, desactivada).',
  })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({
    enum: OnlineBookingMode,
    enumName: 'OnlineBookingMode',
    description:
      'Pacientes nuevos: SOLICITUD (recepción la acepta) o reserva DIRECTA.',
  })
  @IsEnum(OnlineBookingMode)
  newPatientMode!: OnlineBookingMode;

  @ApiProperty({
    enum: OnlineBookingMode,
    enumName: 'OnlineBookingMode',
    description:
      'Pacientes existentes (identificados con el código del email).',
  })
  @IsEnum(OnlineBookingMode)
  existingPatientMode!: OnlineBookingMode;

  @ApiProperty({
    minimum: 0,
    maximum: ONLINE_LEAD_MAX_MINUTES,
    example: 120,
    description: 'Antelación mínima (minutos) para pacientes nuevos.',
  })
  @IsInt({ message: ONLINE_SETTINGS_MESSAGES.lead })
  @Min(0, { message: ONLINE_SETTINGS_MESSAGES.lead })
  @Max(ONLINE_LEAD_MAX_MINUTES, { message: ONLINE_SETTINGS_MESSAGES.lead })
  minLeadMinutesNew!: number;

  @ApiProperty({
    minimum: 0,
    maximum: ONLINE_LEAD_MAX_MINUTES,
    example: 120,
    description: 'Antelación mínima (minutos) para pacientes existentes.',
  })
  @IsInt({ message: ONLINE_SETTINGS_MESSAGES.lead })
  @Min(0, { message: ONLINE_SETTINGS_MESSAGES.lead })
  @Max(ONLINE_LEAD_MAX_MINUTES, { message: ONLINE_SETTINGS_MESSAGES.lead })
  minLeadMinutesExisting!: number;

  @ApiProperty({
    minimum: 1,
    maximum: ONLINE_ADVANCE_MAX_DAYS,
    example: 60,
    description: 'Hasta cuántos días adelante se ofrecen huecos.',
  })
  @IsInt({ message: ONLINE_SETTINGS_MESSAGES.advance })
  @Min(1, { message: ONLINE_SETTINGS_MESSAGES.advance })
  @Max(ONLINE_ADVANCE_MAX_DAYS, { message: ONLINE_SETTINGS_MESSAGES.advance })
  maxAdvanceDays!: number;

  @ApiProperty({
    minimum: ONLINE_STEP_MIN,
    maximum: ONLINE_STEP_MAX,
    example: 15,
    description: 'Cada cuántos minutos empieza un hueco (múltiplo de 5).',
  })
  @IsInt({ message: ONLINE_SETTINGS_MESSAGES.step })
  @Min(ONLINE_STEP_MIN, { message: ONLINE_SETTINGS_MESSAGES.step })
  @Max(ONLINE_STEP_MAX, { message: ONLINE_SETTINGS_MESSAGES.step })
  slotStepMinutes!: number;
}

export class OnlineBookingSettingsDto extends UpdateOnlineBookingSettingsDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Último cambio; null = nunca configurada.',
  })
  updatedAt!: Date | null;
}

export class UpdateOnlineTypeDto {
  @ApiProperty({ description: 'Se ofrece en la página pública.' })
  @IsBoolean()
  visibleOnline!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: ONLINE_DURATION_MIN,
    maximum: ONLINE_DURATION_MAX,
    description: 'Duración para pacientes nuevos (null = la del tipo).',
  })
  @IsOptional()
  @IsInt({ message: ONLINE_SETTINGS_MESSAGES.duration })
  durationNewMinutes!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: ONLINE_DURATION_MIN,
    maximum: ONLINE_DURATION_MAX,
    description: 'Duración para pacientes existentes (null = la del tipo).',
  })
  @IsOptional()
  @IsInt({ message: ONLINE_SETTINGS_MESSAGES.duration })
  durationExistingMinutes!: number | null;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    maxItems: ONLINE_MAX_IDS,
    description:
      'Profesionales que lo atienden online (vacío = todos los que atienden en la sede).',
  })
  @IsArray()
  @ArrayMaxSize(ONLINE_MAX_IDS, {
    message: ONLINE_SETTINGS_MESSAGES.tooManyIds,
  })
  @IsUUID('all', {
    each: true,
    message: ONLINE_SETTINGS_MESSAGES.unknownProvider,
  })
  providerIds!: string[];

  @ApiProperty({
    type: [String],
    format: 'uuid',
    maxItems: ONLINE_MAX_IDS,
    description: 'Sedes en que se ofrece (vacío = todas).',
  })
  @IsArray()
  @ArrayMaxSize(ONLINE_MAX_IDS, {
    message: ONLINE_SETTINGS_MESSAGES.tooManyIds,
  })
  @IsUUID('all', {
    each: true,
    message: ONLINE_SETTINGS_MESSAGES.unknownLocation,
  })
  locationIds!: string[];
}

export class OnlineTypeDto extends UpdateOnlineTypeDto {
  @ApiProperty({ format: 'uuid' })
  appointmentTypeId!: string;
  @ApiProperty()
  name!: string;
  @ApiProperty({ example: '#0E7490' })
  color!: string;
  @ApiProperty({ description: 'Duración del tipo en el catálogo.' })
  durationMinutes!: number;
  @ApiProperty({
    description: 'Activo en el catálogo (uno inactivo no se ofrece).',
  })
  active!: boolean;
}

// ---------------------------------------------------------------------------
// Personal: bandeja
// ---------------------------------------------------------------------------

export class ListOnlineRequestsQueryDto {
  @ApiPropertyOptional({
    enum: OnlineBookingStatus,
    enumName: 'OnlineBookingStatus',
    description: 'Sin él, todas.',
  })
  @IsOptional()
  @IsEnum(OnlineBookingStatus)
  status?: OnlineBookingStatus;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;
}

class RefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
}
class NamedRefDto extends RefDto {
  @ApiProperty()
  name!: string;
}
class RequestLocationDto extends NamedRefDto {
  @ApiProperty({ type: String, nullable: true })
  timeZone!: string | null;
}
class RequestTypeDto extends NamedRefDto {
  @ApiProperty()
  color!: string;
}
class FullNameRefDto extends RefDto {
  @ApiProperty()
  fullName!: string;
}

export class OnlineRequestDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty({ enum: OnlineBookingStatus, enumName: 'OnlineBookingStatus' })
  status!: OnlineBookingStatus;
  @ApiProperty({ enum: OnlineBookingMode, enumName: 'OnlineBookingMode' })
  mode!: OnlineBookingMode;
  @ApiProperty({
    enum: OnlineBookingPatientKind,
    enumName: 'OnlineBookingPatientKind',
  })
  patientKind!: OnlineBookingPatientKind;
  @ApiProperty({
    description:
      'Un «nuevo» parecido a una ficha: no se creó otra; comprueba antes de aceptar.',
  })
  possibleDuplicate!: boolean;
  @ApiProperty({ format: 'date-time' })
  start!: Date;
  @ApiProperty({ format: 'date-time' })
  end!: Date;
  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt!: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Lo que escribió en la página (no cambia la ficha).',
  })
  contactEmail!: string | null;
  @ApiProperty({ type: String, nullable: true })
  contactPhone!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  appointmentId!: string | null;
  @ApiProperty({ type: RequestLocationDto })
  location!: RequestLocationDto;
  @ApiProperty({ type: FullNameRefDto })
  provider!: FullNameRefDto;
  @ApiProperty({ type: RequestTypeDto })
  appointmentType!: RequestTypeDto;
  @ApiProperty({ type: FullNameRefDto })
  patient!: FullNameRefDto;
}

export class OnlineRequestPageDto {
  @ApiProperty({ type: [OnlineRequestDto] })
  items!: OnlineRequestDto[];
  @ApiProperty()
  total!: number;
}

export class OnlinePendingCountDto {
  @ApiProperty({
    description: 'Solicitudes online por revisar en las sedes permitidas.',
  })
  pending!: number;
}

// ---------------------------------------------------------------------------
// Página pública
// ---------------------------------------------------------------------------

/** Campos anti-bots de todos los formularios públicos. */
class AntiBotDto {
  @ApiPropertyOptional({
    description: 'Campo trampa: SIEMPRE vacío (oculto para las personas).',
  })
  @IsOptional()
  website?: unknown;

  @ApiProperty({
    description:
      'El `formToken` de GET /public/booking (mide el tiempo de rellenado).',
  })
  @IsString({ message: BAD })
  @MaxLength(100, { message: BAD })
  formToken!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Reservado para el desafío anti-bots de un proveedor (pendiente; hoy no se exige).',
  })
  @IsOptional()
  @IsString({ message: BAD })
  @MaxLength(4096, { message: BAD })
  challengeToken?: string | null;
}

export class PublicSlotsQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', { message: BAD })
  locationId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', { message: BAD })
  appointmentTypeId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Sin él, cualquiera de los profesionales del tipo.',
  })
  @IsOptional()
  @IsUUID('all', { message: BAD })
  providerId?: string;

  @ApiProperty({
    enum: OnlineBookingPatientKind,
    enumName: 'OnlineBookingPatientKind',
    description:
      'Decide la duración y la antelación (con sesión manda la sesión).',
  })
  @IsEnum(OnlineBookingPatientKind, { message: BAD })
  patientKind!: OnlineBookingPatientKind;

  @ApiProperty({
    example: '2026-12-01',
    description: 'Primer día (YYYY-MM-DD) en la zona de la sede.',
  })
  @IsString({ message: BAD })
  @MaxLength(10, { message: BAD })
  from!: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_ONLINE_SLOT_DAYS,
    default: 7,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: BAD })
  @Min(1, { message: BAD })
  @Max(MAX_ONLINE_SLOT_DAYS, { message: BAD })
  days?: number;
}

export class PublicSlotDto {
  @ApiProperty({ format: 'date-time' })
  start!: Date;
  @ApiProperty({ format: 'date-time' })
  end!: Date;
  @ApiProperty({
    format: 'uuid',
    description: 'El profesional libre en ese hueco.',
  })
  providerId!: string;
}

export class PublicSlotsDto {
  @ApiProperty({ example: 'America/Caracas' })
  timeZone!: string;
  @ApiProperty()
  durationMinutes!: number;
  @ApiProperty({ type: [PublicSlotDto] })
  slots!: PublicSlotDto[];
  @ApiProperty()
  truncated!: boolean;
}

class PublicLocationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty()
  name!: string;
  @ApiProperty({ type: String, nullable: true })
  address!: string | null;
  @ApiProperty({ example: 'America/Caracas' })
  timeZone!: string;
}

class PublicTypeDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty()
  name!: string;
  @ApiProperty()
  durationNewMinutes!: number;
  @ApiProperty()
  durationExistingMinutes!: number;
  @ApiProperty({ type: [String], format: 'uuid' })
  locationIds!: string[];
  @ApiProperty({ type: [String], format: 'uuid' })
  providerIds!: string[];
}

class PublicProviderDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty()
  name!: string;
  @ApiProperty({ type: [String], format: 'uuid' })
  locationIds!: string[];
}

class PublicPrivacyPolicyDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty()
  version!: number;
  @ApiProperty()
  policyText!: string;
  @ApiProperty({ description: 'Lo que autoriza la casilla del formulario.' })
  generalText!: string;
}

export class PublicBookingConfigDto {
  @ApiProperty()
  clinicName!: string;
  @ApiProperty({ enum: OnlineBookingMode, enumName: 'OnlineBookingMode' })
  newPatientMode!: OnlineBookingMode;
  @ApiProperty({ enum: OnlineBookingMode, enumName: 'OnlineBookingMode' })
  existingPatientMode!: OnlineBookingMode;
  @ApiProperty({
    description:
      'Sin política de datos publicada, un paciente nuevo no puede reservar online.',
  })
  newPatientsAllowed!: boolean;
  @ApiProperty()
  minLeadMinutesNew!: number;
  @ApiProperty()
  minLeadMinutesExisting!: number;
  @ApiProperty()
  maxAdvanceDays!: number;
  @ApiProperty({ type: [PublicLocationDto] })
  locations!: PublicLocationDto[];
  @ApiProperty({ type: [PublicTypeDto] })
  types!: PublicTypeDto[];
  @ApiProperty({ type: [PublicProviderDto] })
  providers!: PublicProviderDto[];
  @ApiProperty({ type: PublicPrivacyPolicyDto, nullable: true })
  privacyPolicy!: PublicPrivacyPolicyDto | null;
  @ApiProperty({
    description: 'Se devuelve en cada envío (tiempo mínimo de rellenado).',
  })
  formToken!: string;
}

export class RequestBookingCodeDto extends AntiBotDto {
  @ApiProperty({ maxLength: 80, example: 'María' })
  @IsString({ message: BAD })
  @MaxLength(80, { message: BAD })
  firstName!: string;

  @ApiProperty({ maxLength: 80, example: 'Pérez' })
  @IsString({ message: BAD })
  @MaxLength(80, { message: BAD })
  lastName!: string;

  @ApiProperty({ example: '1990-05-14' })
  @IsString({ message: BAD })
  @MaxLength(10, { message: BAD })
  birthDate!: string;

  @ApiProperty({ maxLength: 254, example: 'maria.perez@example.com' })
  @IsString({ message: BAD })
  @MaxLength(254, { message: BAD })
  email!: string;
}

export class BookingCodeSentDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Se devuelve SIEMPRE (también si los datos no casan con ninguna ficha).',
  })
  verificationId!: string;
  @ApiProperty({ format: 'date-time' })
  expiresAt!: Date;
  @ApiProperty()
  message!: string;
}

export class VerifyBookingCodeDto {
  @ApiProperty({ example: '123456' })
  @IsString({ message: BAD })
  @MaxLength(6, { message: BAD })
  code!: string;
}

export class BookingSessionDto {
  @ApiProperty({
    description:
      'Va en la cabecera X-Booking-Session de los huecos y de la reserva.',
  })
  sessionToken!: string;
  @ApiProperty({ format: 'date-time' })
  expiresAt!: Date;
}

export class NewPatientDto {
  @ApiProperty({ maxLength: 80, example: 'Luis' })
  @IsString({ message: BAD })
  @MaxLength(80, { message: BAD })
  firstName!: string;

  @ApiProperty({ maxLength: 80, example: 'Rodríguez' })
  @IsString({ message: BAD })
  @MaxLength(80, { message: BAD })
  lastName!: string;

  @ApiProperty({ example: '1988-02-03' })
  @IsString({ message: BAD })
  @MaxLength(10, { message: BAD })
  birthDate!: string;

  @ApiProperty({ maxLength: 254, example: 'luis.rodriguez@example.com' })
  @IsString({ message: BAD })
  @MaxLength(254, { message: BAD })
  email!: string;

  @ApiProperty({ maxLength: 40, description: 'Teléfono de contacto (con prefijo internacional si es de otro país).' })
  @IsString({ message: BAD })
  @MaxLength(40, { message: BAD })
  phone!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'La política vigente que se le mostró.',
  })
  @IsUUID('all', { message: BAD })
  consentPolicyVersionId!: string;

  @ApiProperty({
    description: 'Acepta el tratamiento de sus datos (obligatorio).',
  })
  @IsBoolean({ message: BAD })
  consentAccepted!: boolean;
}

export class CreatePublicBookingDto extends AntiBotDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', { message: BAD })
  locationId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', { message: BAD })
  appointmentTypeId!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Sin él, el primero libre a esa hora.',
  })
  @IsOptional()
  @IsUUID('all', { message: BAD })
  providerId?: string | null;

  @ApiProperty({
    format: 'date-time',
    description: 'Inicio de uno de los huecos de GET /public/booking/slots.',
  })
  @Type(() => Date)
  @IsDate({ message: BAD })
  start!: Date;

  @ApiPropertyOptional({
    type: NewPatientDto,
    description:
      'Paciente nuevo. Para uno existente, la cabecera X-Booking-Session.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => NewPatientDto)
  newPatient?: NewPatientDto;
}

export class PublicBookingResultDto {
  @ApiProperty({
    enum: ['BOOKED', 'REQUESTED'],
    description:
      'BOOKED = cita reservada; REQUESTED = solicitud por confirmar.',
  })
  @IsIn(['BOOKED', 'REQUESTED'])
  status!: 'BOOKED' | 'REQUESTED';
  @ApiProperty({ format: 'date-time' })
  start!: Date;
  @ApiProperty({ format: 'date-time' })
  end!: Date;
  @ApiProperty({ example: 'America/Caracas' })
  timeZone!: string;
  @ApiProperty()
  locationName!: string;
  @ApiProperty()
  providerName!: string;
  @ApiProperty()
  appointmentTypeName!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Enlace para confirmar o cancelar la cita (DX-005).',
  })
  manageUrl!: string | null;
}
