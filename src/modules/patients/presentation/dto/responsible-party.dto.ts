import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DocumentType, ResponsibleRelationship } from '@prisma/client';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { CommunicationRecipientDto } from './patient-communication.dto';
import { DOCUMENT_TYPES } from '../../domain/document-type';
import {
  DOC_TYPE_INPUTS,
  DOC_TYPE_LABEL_PROPERTY,
  DOC_TYPE_MESSAGE,
  DOC_TYPE_NAME_DESCRIPTION,
  type DocTypeInput,
} from './doc-type-input';
import { PHONE_INTERNATIONAL_DOC } from '../../../../shared/phone/with-phone-international';

export const RESPONSIBLE_NAME_MAX = 200;
export const RESPONSIBLE_DOC_MAX = 60;
export const RESPONSIBLE_EMAIL_MAX = 254;
export const RESPONSIBLE_PHONE_MAX = 40;

const RELATIONSHIP_MESSAGE =
  'relationship debe ser MOTHER, FATHER, LEGAL_GUARDIAN, GRANDPARENT, SIBLING, SPOUSE, CHILD u OTHER.';
const EMAIL_MESSAGE = 'El email del responsable no es válido.';

/** Lo que se puede tocar de un contacto (null o vacío = borrarlo). */
class ResponsibleContactPatchDto {
  @ApiPropertyOptional({ maxLength: RESPONSIBLE_NAME_MAX })
  @IsOptional()
  @IsString({ message: 'fullName debe ser un texto.' })
  @MaxLength(RESPONSIBLE_NAME_MAX, {
    message: `El nombre admite hasta ${RESPONSIBLE_NAME_MAX} caracteres.`,
  })
  fullName?: string;

  @ApiPropertyOptional({
    enum: DOCUMENT_TYPES,
    enumName: 'DocType',
    nullable: true,
  })
  @IsOptional()
  @IsIn(DOC_TYPE_INPUTS, { message: DOC_TYPE_MESSAGE })
  docType?: DocTypeInput | null;

  // DX-327 (R7): exige tipo; quitar el tipo la quita; y si cambia el tipo sin
  // traer otra, se borra.
  @ApiPropertyOptional(DOC_TYPE_LABEL_PROPERTY)
  @IsOptional()
  @IsString({ message: 'docTypeLabel debe ser un texto.' })
  docTypeLabel?: string | null;

  @ApiPropertyOptional({
    type: String,
    maxLength: RESPONSIBLE_DOC_MAX,
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: 'docNumber debe ser un texto.' })
  @MaxLength(RESPONSIBLE_DOC_MAX, {
    message: `El documento admite hasta ${RESPONSIBLE_DOC_MAX} caracteres.`,
  })
  docNumber?: string | null;

  @ApiPropertyOptional({
    type: String,
    maxLength: RESPONSIBLE_EMAIL_MAX,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o: { email?: string | null }) => !!o.email?.trim())
  @IsEmail({}, { message: EMAIL_MESSAGE })
  @MaxLength(RESPONSIBLE_EMAIL_MAX, { message: EMAIL_MESSAGE })
  email?: string | null;

  @ApiPropertyOptional({
    type: String,
    maxLength: RESPONSIBLE_PHONE_MAX,
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: 'phone debe ser un texto.' })
  @MaxLength(RESPONSIBLE_PHONE_MAX, {
    message: `El teléfono admite hasta ${RESPONSIBLE_PHONE_MAX} caracteres.`,
  })
  phone?: string | null;
}

/**
 * Alta de un responsable (DX-203): `responsiblePatientId` (otro paciente de
 * la clínica) O los datos de un contacto sin ficha (`fullName` obligatorio).
 */
export class CreateResponsiblePartyDto extends ResponsibleContactPatchDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Paciente de ESTA clínica que es el responsable (404 si no). Sin él, `fullName` es obligatorio.',
  })
  @IsOptional()
  @IsUUID('4', { message: 'responsiblePatientId debe ser un UUID.' })
  responsiblePatientId?: string;

  @ApiProperty({
    enum: ResponsibleRelationship,
    enumName: 'ResponsibleRelationship',
  })
  @IsEnum(ResponsibleRelationship, { message: RELATIONSHIP_MESSAGE })
  relationship!: ResponsibleRelationship;

  @ApiPropertyOptional({
    default: false,
    description:
      'Pagador principal: como mucho uno por paciente (422 si ya hay otro).',
  })
  @IsOptional()
  @IsBoolean({ message: 'isPayer debe ser true o false.' })
  isPayer?: boolean;

  @ApiPropertyOptional({
    default: true,
    description:
      'Recibe los avisos de un menor o de un paciente sin email (recordatorio, recibo, estado de cuenta).',
  })
  @IsOptional()
  @IsBoolean({ message: 'receivesNotices debe ser true o false.' })
  receivesNotices?: boolean;
}

/** Edición: parentesco, pagador, avisos y (solo un contacto) sus datos. */
export class UpdateResponsiblePartyDto extends ResponsibleContactPatchDto {
  @ApiPropertyOptional({
    enum: ResponsibleRelationship,
    enumName: 'ResponsibleRelationship',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsEnum(ResponsibleRelationship, { message: RELATIONSHIP_MESSAGE })
  relationship?: ResponsibleRelationship;

  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean({ message: 'isPayer debe ser true o false.' })
  isPayer?: boolean;

  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean({ message: 'receivesNotices debe ser true o false.' })
  receivesNotices?: boolean;
}

export class ResponsiblePatientSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;

  @ApiProperty({ enum: DOCUMENT_TYPES, enumName: 'DocType' })
  docType!: DocumentType;

  @ApiProperty(DOC_TYPE_LABEL_PROPERTY)
  docTypeLabel!: string | null;

  @ApiProperty({ description: DOC_TYPE_NAME_DESCRIPTION })
  docTypeName!: string;

  @ApiProperty({ type: String, nullable: true })
  docNumber!: string | null;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: PHONE_INTERNATIONAL_DOC,
  })
  phoneInternational!: string | null;
}

export class ResponsiblePartyDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({
    enum: ['PATIENT', 'CONTACT'],
    enumName: 'ResponsiblePartyKind',
    description:
      'PATIENT: otro paciente de la clínica (sus datos salen de su ficha). CONTACT: contacto sin ficha.',
  })
  kind!: 'PATIENT' | 'CONTACT';

  @ApiProperty({ type: ResponsiblePatientSummaryDto, nullable: true })
  responsiblePatient!: ResponsiblePatientSummaryDto | null;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ enum: DOCUMENT_TYPES, enumName: 'DocType', nullable: true })
  docType!: DocumentType | null;

  @ApiProperty(DOC_TYPE_LABEL_PROPERTY)
  docTypeLabel!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: `${DOC_TYPE_NAME_DESCRIPTION} Null si no tiene tipo.`,
  })
  docTypeName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  docNumber!: string | null;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: PHONE_INTERNATIONAL_DOC,
  })
  phoneInternational!: string | null;

  @ApiProperty({
    enum: ResponsibleRelationship,
    enumName: 'ResponsibleRelationship',
  })
  relationship!: ResponsibleRelationship;

  @ApiProperty()
  isPayer!: boolean;

  @ApiProperty()
  receivesNotices!: boolean;

  @ApiProperty({
    description:
      'Copiado del tutor antiguo de la ficha (guardianName, DEPRECADO).',
  })
  migratedFromGuardian!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

class ResponsibleForPatientDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;
}

export class ResponsibleForDto {
  @ApiProperty({ format: 'uuid', description: 'Id del vínculo' })
  id!: string;

  @ApiProperty({ type: ResponsibleForPatientDto })
  patient!: ResponsibleForPatientDto;

  @ApiProperty({
    enum: ResponsibleRelationship,
    enumName: 'ResponsibleRelationship',
  })
  relationship!: ResponsibleRelationship;

  @ApiProperty()
  isPayer!: boolean;

  @ApiProperty()
  receivesNotices!: boolean;
}

/** Bloque «Responsable y familia» de la ficha (DX-203). */
export class PatientResponsiblesDto {
  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({
    description:
      'Menor que la mayoría de edad de la clínica (`majorityAge`), en el día civil de la sede activa o principal.',
  })
  minor!: boolean;

  @ApiProperty({
    example: 18,
    description:
      'Edad desde la que el paciente es adulto en esta clínica (Ajustes › Mayoría de edad).',
  })
  majorityAge!: number;

  @ApiProperty({ type: [ResponsiblePartyDto] })
  parties!: ResponsiblePartyDto[];

  @ApiProperty({
    type: [ResponsibleForDto],
    description:
      '«Responsable de: …»: los pacientes de los que es responsable.',
  })
  responsibleFor!: ResponsibleForDto[];

  @ApiProperty({
    type: CommunicationRecipientDto,
    description: 'A quién van hoy sus avisos.',
  })
  noticeRecipient!: CommunicationRecipientDto;
}
