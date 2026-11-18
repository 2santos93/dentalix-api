import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AppointmentStatus, PatientAccessScope } from '@prisma/client';
import { AccountStatementDto } from '../../../account-statement/presentation/dto/account-statement.dto';
import { PlanQuoteDocumentDto } from '../../../treatment-plans/presentation/dto/plan-quote.dto';
import {
  PATIENT_ACCESS_MAX_TTL_DAYS,
  PATIENT_ACCESS_MIN_TTL_DAYS,
  PATIENT_ACCESS_SCOPES,
} from '../../domain/patient-access';

const SCOPE_ENUM = {
  enum: PATIENT_ACCESS_SCOPES,
  enumName: 'PatientAccessScope',
} as const;

// --- personal ----------------------------------------------------------------

export class CreateAccessLinkDto {
  @ApiProperty({
    ...SCOPE_ENUM,
    isArray: true,
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
    example: ['APPOINTMENTS', 'PLANS', 'ACCOUNT'],
    description:
      'Apartados que verá el paciente: citas futuras, presupuestos (presentados o aceptados) y estado de cuenta.',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'Elige al menos un apartado.' })
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsIn(PATIENT_ACCESS_SCOPES, {
    each: true,
    message: 'Apartado no válido.',
  })
  scopes!: PatientAccessScope[];

  @ApiPropertyOptional({
    minimum: PATIENT_ACCESS_MIN_TTL_DAYS,
    maximum: PATIENT_ACCESS_MAX_TTL_DAYS,
    default: 14,
    description: 'Días de validez del enlace (por defecto 14).',
  })
  @IsOptional()
  @IsInt({ message: 'La validez va en días enteros.' })
  @Min(PATIENT_ACCESS_MIN_TTL_DAYS, {
    message: `La validez mínima es de ${PATIENT_ACCESS_MIN_TTL_DAYS} día.`,
  })
  @Max(PATIENT_ACCESS_MAX_TTL_DAYS, {
    message: `La validez máxima es de ${PATIENT_ACCESS_MAX_TTL_DAYS} días.`,
  })
  ttlDays?: number;
}

export class AccessLinkWhatsAppDto {
  @ApiProperty({ description: 'Dígitos para wa.me (sin +).' })
  phone!: string;

  @ApiProperty({
    description:
      'Mensaje prellenado: nombre de pila, clínica, apartados, caducidad y URL; sin importes.',
  })
  text!: string;
}

export class CreatedAccessLinkDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    description:
      'URL con el token: SOLO en esta respuesta (la BD guarda su hash). Copiarla o enviarla ahora.',
  })
  url!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: Date;

  @ApiProperty({ ...SCOPE_ENUM, isArray: true })
  scopes!: PatientAccessScope[];

  @ApiProperty({ type: AccessLinkWhatsAppDto, nullable: true })
  whatsapp!: AccessLinkWhatsAppDto | null;

  @ApiProperty({
    description:
      'El paciente es menor de edad: el enlace debe recibirlo su responsable (aviso en la UI).',
  })
  minor!: boolean;
}

export class AccessLinkCreatorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, nullable: true })
  fullName!: string | null;
}

export class AccessLinkDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ ...SCOPE_ENUM, isArray: true })
  scopes!: PatientAccessScope[];

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Último acceso verificado (fecha correcta); null si nunca.',
  })
  lastViewedAt!: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Bloqueado por 5 fechas erróneas hasta esta hora; null si no.',
  })
  lockedUntil!: Date | null;

  @ApiProperty({ type: AccessLinkCreatorDto })
  createdBy!: AccessLinkCreatorDto;
}

// --- público -----------------------------------------------------------------

export class VerifyPatientAccessDto {
  @ApiProperty({
    example: '1990-05-21',
    description: 'Fecha de nacimiento del paciente (AAAA-MM-DD).',
  })
  @IsString({ message: 'Escribe la fecha de nacimiento.' })
  @MaxLength(32)
  birthDate!: string;
}

export class PatientAccessSessionDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'Fin de la sesión (30 min, o antes si el enlace caduca). La sesión va en la cookie HttpOnly `dentalix_pa`, nunca en el body.',
  })
  sessionExpiresAt!: Date;

  @ApiProperty({ ...SCOPE_ENUM, isArray: true })
  scopes!: PatientAccessScope[];
}

export class PortalLocationDto {
  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  address!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'America/Caracas' })
  timeZone!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'es-VE' })
  locale!: string | null;

  @ApiProperty({
    enum: ['h12', 'h23'],
    enumName: 'HourCycle',
    nullable: true,
  })
  hourCycle!: 'h12' | 'h23' | null;
}

export class PortalAppointmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  start!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  end!: Date;

  @ApiProperty({ enum: AppointmentStatus, enumName: 'AppointmentStatus' })
  status!: AppointmentStatus;

  @ApiProperty({ type: String, nullable: true })
  typeName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  providerName!: string | null;

  @ApiProperty({ type: PortalLocationDto })
  location!: PortalLocationDto;

  @ApiProperty({
    description:
      'Agendada sin confirmar y futura: la página ofrece «Confirmar».',
  })
  confirmable!: boolean;
}

export class PortalPlanDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['PRESENTED', 'ACCEPTED'] })
  status!: 'PRESENTED' | 'ACCEPTED';

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Grupo de alternativas (DX-040): los planes con el mismo grupo son opciones A/B.',
  })
  optionGroupId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'A' })
  optionLabel!: string | null;

  @ApiProperty({
    type: PlanQuoteDocumentDto,
    description:
      'El presupuesto de DX-012 (ítems y totales), el mismo del PDF.',
  })
  quote!: PlanQuoteDocumentDto;
}

export class PatientPortalDto {
  @ApiProperty()
  clinicName!: string;

  @ApiProperty({ description: 'Solo el nombre de pila.' })
  patientFirstName!: string;

  @ApiProperty({
    description:
      'Paciente menor de edad: lo consulta su responsable (aviso en la página).',
  })
  minor!: boolean;

  @ApiProperty({ ...SCOPE_ENUM, isArray: true })
  scopes!: PatientAccessScope[];

  @ApiProperty({ type: String, format: 'date-time' })
  sessionExpiresAt!: Date;

  @ApiProperty({
    type: [PortalAppointmentDto],
    nullable: true,
    description:
      'Citas futuras (agendadas o confirmadas); null si no se compartió.',
  })
  appointments!: PortalAppointmentDto[] | null;

  @ApiProperty({
    type: [PortalPlanDto],
    nullable: true,
    description:
      'Presupuestos presentados o aceptados; null si no se compartió.',
  })
  plans!: PortalPlanDto[] | null;

  @ApiProperty({
    type: AccountStatementDto,
    nullable: true,
    description:
      'El estado de cuenta de DX-011 con los mismos importes que ve el personal, sin datos internos (quién registró o anuló, si se puede anular); null si no se compartió.',
  })
  account!: AccountStatementDto | null;
}

export class PortalAppointmentConfirmedDto {
  @ApiProperty({ enum: ['CONFIRMED'] })
  status!: 'CONFIRMED';
}
