import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ContactChannel,
  ReminderOptOutSource,
  WhatsappOptInSource,
} from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

const PHONE_MAX = 40;

export class WhatsappOptInDto {
  @ApiProperty({ format: 'date-time' })
  at!: Date;

  @ApiProperty({ enum: WhatsappOptInSource, enumName: 'WhatsappOptInSource' })
  source!: WhatsappOptInSource;

  @ApiProperty({
    type: () => CommunicationActorDto,
    nullable: true,
    description:
      'Quién lo registró en la clínica; null si lo dio el propio paciente.',
  })
  recordedBy!: CommunicationActorDto | null;
}

export class CommunicationActorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'null si ya no es miembro de la clínica.',
  })
  fullName!: string | null;
}

export class ReminderOptOutDto {
  @ApiProperty({ format: 'date-time' })
  at!: Date;

  @ApiProperty({
    enum: ReminderOptOutSource,
    enumName: 'ReminderOptOutSource',
    description:
      'LINK: enlace del email. MESSAGE: respondió «BAJA» al mensaje. STAFF: lo anotó recepción.',
  })
  source!: ReminderOptOutSource;
}

export class CommunicationRecipientDto {
  @ApiProperty({
    enum: ['PATIENT', 'RESPONSIBLE', 'GUARDIAN', 'CONTACT'],
    enumName: 'CommunicationRecipientKind',
    description:
      'PATIENT: el propio paciente. RESPONSIBLE (DX-203): un menor (CO < 18, ES < 16) o un paciente sin email; los avisos van al email de su responsable que recibe avisos (primero el pagador). GUARDIAN: menor cuyo responsable no tiene email; va al email de la ficha saludándolo. CONTACT: menor sin responsables; se saluda a su contacto principal.',
  })
  kind!: 'PATIENT' | 'RESPONSIBLE' | 'GUARDIAN' | 'CONTACT';

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Nombre de pila de a quien se dirigen los avisos.',
  })
  name!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Email al que salen los avisos; null = no hay a quién.',
  })
  email!: string | null;

  @ApiProperty({
    description:
      'Menor según el país de la sede (CO: menos de 18; ES: menos de 16).',
  })
  minor!: boolean;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Responsable que recibe los avisos (RESPONSIBLE y GUARDIAN).',
  })
  responsiblePartyId!: string | null;
}

/** Bloque «Comunicaciones» de la ficha (DX-128). */
export class PatientCommunicationDto {
  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({
    enum: ContactChannel,
    enumName: 'ContactChannel',
    description:
      'Canal de los avisos automáticos (recordatorios). NONE: ninguno. No es el consentimiento de marketing (DX-037).',
  })
  contactChannel!: ContactChannel;

  @ApiProperty({
    enum: ContactChannel,
    enumName: 'ContactChannel',
    description: 'Canal con el que nacen los pacientes de la clínica.',
  })
  clinicDefaultChannel!: ContactChannel;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Tal como está guardado.',
  })
  phone!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '+573101234567',
    description: 'E.164, solo si es un móvil válido.',
  })
  phoneE164!: string | null;

  @ApiProperty({
    enum: ['MISSING', 'VALID', 'INVALID'],
    enumName: 'MobileStatus',
    description:
      'MISSING: sin móvil. INVALID: no es un móvil válido para el país de la sede (no puede ser canal WhatsApp).',
  })
  phoneStatus!: 'MISSING' | 'VALID' | 'INVALID';

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'CO',
    description:
      'País con el que se valida un número sin indicativo: el de la sede activa o la principal.',
  })
  phoneCountry!: string | null;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;

  @ApiProperty({ type: WhatsappOptInDto, nullable: true })
  whatsappOptIn!: WhatsappOptInDto | null;

  @ApiProperty({ type: ReminderOptOutDto, nullable: true })
  reminderOptOut!: ReminderOptOutDto | null;

  @ApiProperty({
    type: CommunicationRecipientDto,
    description:
      'A quién se dirigen los avisos (como Dentrix Ascend: un menor, a su tutor o contacto principal). Usan el correo y el móvil de la ficha.',
  })
  recipient!: CommunicationRecipientDto;
}

/**
 * Cambio del bloque «Comunicaciones». Todo opcional: ausente = no se toca.
 * Solo recepción y ADMIN.
 */
export class UpdatePatientCommunicationDto {
  @ApiPropertyOptional({ enum: ContactChannel, enumName: 'ContactChannel' })
  @ValidateIf((_o: unknown, v: unknown) => v !== undefined)
  @IsEnum(ContactChannel, {
    message: 'El canal debe ser email, WhatsApp o ninguno.',
  })
  contactChannel?: ContactChannel;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: PHONE_MAX,
    description:
      'Móvil. Se guarda en E.164 si es válido para el país de la sede; null o vacío lo borra.',
  })
  @IsOptional()
  @IsString({ message: 'El móvil debe ser un texto.' })
  @MaxLength(PHONE_MAX, {
    message: `El móvil admite como máximo ${PHONE_MAX} caracteres.`,
  })
  phone?: string | null;

  @ApiPropertyOptional({
    description:
      'true registra el opt-in de WhatsApp (exige `whatsappOptInSource` y un móvil válido); false lo retira.',
  })
  @ValidateIf((_o: unknown, v: unknown) => v !== undefined)
  @IsBoolean({ message: 'Indica si el paciente acepta WhatsApp (sí o no).' })
  whatsappOptIn?: boolean;

  @ApiPropertyOptional({
    enum: WhatsappOptInSource,
    enumName: 'WhatsappOptInSource',
  })
  @ValidateIf((_o: unknown, v: unknown) => v !== undefined)
  @IsEnum(WhatsappOptInSource, {
    message: 'El origen del opt-in debe ser en persona, enlace o mensaje.',
  })
  whatsappOptInSource?: WhatsappOptInSource;

  @ApiPropertyOptional({
    description:
      'true anota la baja de los recordatorios a petición del paciente (origen STAFF); false la quita y los reactiva.',
  })
  @ValidateIf((_o: unknown, v: unknown) => v !== undefined)
  @IsBoolean({
    message:
      'Indica si el paciente se da de baja de los recordatorios (sí o no).',
  })
  reminderOptOut?: boolean;
}

/** DX-214: metadatos mínimos del aviso, sin datos de contacto. */
export class PatientOptOutMatchWarningDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ minimum: 2 }) matchCount!: number;
  @ApiProperty({ minimum: 1 }) maxMatches!: number;
}
