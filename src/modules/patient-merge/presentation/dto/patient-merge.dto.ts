import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { DocumentType, Sex } from '@prisma/client';
import {
  DUPLICATE_REASONS,
  DUPLICATES_MAX_PAGE,
  DUPLICATES_MAX_PAGE_SIZE,
  type DuplicateReason,
} from '../../domain/duplicate-reasons';
import {
  MERGE_CATEGORIES,
  type MergeCategory,
} from '../../domain/merge-categories';
import { MERGE_BLOCKER_CODES } from '../../domain/merge-errors';
import {
  MERGE_FIELD_GROUP_NAMES,
  MERGE_FIELD_SOURCES,
  type MergeFieldGroup,
  type MergeFieldSource,
} from '../../domain/merge-fields';
import { LivePublicLinksDto } from '../../../patients/presentation/dto/retention.dto';

const REASON_DESCRIPTION =
  'DOCUMENT: el mismo documento normalizado (solo letras y dígitos: «V-12.345.678» = «v12345678»). ' +
  'NAME_BIRTHDATE: el mismo nombre completo (sin tildes ni mayúsculas) y la misma fecha de nacimiento. ' +
  'PHONE_NAME: el mismo teléfono (8 últimos dígitos) y el mismo primer nombre y primer apellido.';

export class ListDuplicatesQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo parejas en las que alguno de los dos tiene una cita en esta sede o su saldo es de ella.',
  })
  @IsOptional()
  @IsUUID('4', { message: 'locationId debe ser un UUID.' })
  locationId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: DUPLICATES_MAX_PAGE, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un número entero.' })
  @Min(1, { message: 'page empieza en 1.' })
  @Max(DUPLICATES_MAX_PAGE, {
    message: `page admite hasta ${DUPLICATES_MAX_PAGE}.`,
  })
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: DUPLICATES_MAX_PAGE_SIZE,
    default: 20,
    description: `Tope: ${DUPLICATES_MAX_PAGE_SIZE} (un valor mayor se recorta).`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize debe ser un número entero.' })
  @Min(1, { message: 'pageSize debe ser al menos 1.' })
  pageSize?: number;
}

export class DuplicatePatientDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Código corto del paciente (DX-484).' })
  patientCode!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty({ enum: DocumentType, enumName: 'DocumentType' })
  documentType!: DocumentType;
  @ApiProperty({ type: String, nullable: true }) docTypeLabel!: string | null;
  @ApiProperty({ type: String, nullable: true }) docNumber!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date',
    description: 'Día civil AAAA-MM-DD.',
  })
  birthDate!: string | null;
  @ApiProperty({ type: String, nullable: true }) phone!: string | null;
  @ApiProperty({ type: String, nullable: true }) email!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastAttentionAt!: Date | null;
}

export class DuplicatePairDto {
  @ApiProperty({
    type: [DuplicatePatientDto],
    minItems: 2,
    maxItems: 2,
    description: 'Los dos pacientes, en orden de id.',
  })
  patients!: DuplicatePatientDto[];

  @ApiProperty({
    enum: DUPLICATE_REASONS,
    enumName: 'DuplicateReason',
    isArray: true,
    description: REASON_DESCRIPTION,
  })
  reasons!: DuplicateReason[];
}

export class DuplicatePageDto {
  @ApiProperty({ type: [DuplicatePairDto] }) items!: DuplicatePairDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}

/** `POST /patient-duplicates/dismissals`. */
export class DismissDuplicateDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 2,
    maxItems: 2,
    description: 'Los dos pacientes de la pareja (en cualquier orden).',
  })
  @IsArray({ message: 'patientIds tiene que ser una lista de dos pacientes.' })
  @ArrayMinSize(2, { message: 'patientIds lleva exactamente dos pacientes.' })
  @ArrayMaxSize(2, { message: 'patientIds lleva exactamente dos pacientes.' })
  @IsUUID('4', {
    each: true,
    message: 'Cada paciente de patientIds debe ser un UUID.',
  })
  patientIds!: string[];
}

export class MergePreviewQueryDto {
  @ApiProperty({ format: 'uuid', description: 'El paciente que se conserva.' })
  @IsUUID('4', { message: 'keptId debe ser un UUID.' })
  keptId!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'El paciente que se absorbe (queda retirado).',
  })
  @IsUUID('4', { message: 'absorbedId debe ser un UUID.' })
  absorbedId!: string;
}

/** Valores comparables de una ficha (los grupos de `MergeFieldChoicesDto`). */
export class MergeFieldValuesDto {
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty({ enum: DocumentType, enumName: 'DocumentType' })
  documentType!: DocumentType;
  @ApiProperty({ type: String, nullable: true }) docTypeLabel!: string | null;
  @ApiProperty({ type: String, nullable: true }) docNumber!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date' })
  birthDate!: string | null;
  @ApiProperty({ enum: Sex, enumName: 'Sex' }) sex!: Sex;
  @ApiProperty({ type: String, nullable: true }) phone!: string | null;
  @ApiProperty({ type: String, nullable: true }) email!: string | null;
  @ApiProperty({ type: String, nullable: true }) address!: string | null;
  @ApiProperty({ type: String, nullable: true }) countryCode!: string | null;
  @ApiProperty({ type: Number, nullable: true }) cityId!: number | null;
  @ApiProperty({ type: String, nullable: true }) maritalStatus!: string | null;
  @ApiProperty({ type: String, nullable: true }) occupation!: string | null;
  @ApiProperty({ type: String, nullable: true }) physicianName!: string | null;
  @ApiProperty({ type: String, nullable: true }) physicianPhone!: string | null;
  @ApiProperty({ type: String, nullable: true })
  emergencyContactName!: string | null;
  @ApiProperty({ type: String, nullable: true })
  emergencyContactRelationship!: string | null;
  @ApiProperty({ type: String, nullable: true })
  emergencyContactPhone!: string | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: String, nullable: true })
  preferredLanguage!: string | null;
}

export class MergeCategoryCountDto {
  @ApiProperty({ enum: MERGE_CATEGORIES, enumName: 'MergeCategory' })
  category!: MergeCategory;
  @ApiProperty() count!: number;
}

export class MergeSideDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() patientCode!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastAttentionAt!: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Nombre de la ciudad de `fields.cityId`, para enseñarla.',
  })
  cityName!: string | null;
  @ApiProperty({ type: MergeFieldValuesDto }) fields!: MergeFieldValuesDto;
  @ApiProperty({
    type: [MergeCategoryCountDto],
    description: 'Cuánto tiene de cada cosa (lo que pasará al conservado).',
  })
  counts!: MergeCategoryCountDto[];
}

export class MergePreviewDto {
  @ApiProperty({ type: MergeSideDto }) kept!: MergeSideDto;
  @ApiProperty({ type: MergeSideDto }) absorbed!: MergeSideDto;
  @ApiProperty({
    enum: MERGE_BLOCKER_CODES,
    enumName: 'MergeBlocker',
    isArray: true,
    description:
      'Lo que impide fusionar y hay que resolver antes: citas a la misma hora, saldos migrados del mismo lote y moneda, dos compromisos de pago abiertos. Vacío: se puede fusionar.',
  })
  blockers!: string[];
  @ApiProperty({
    type: LivePublicLinksDto,
    description:
      'Enlaces públicos vivos del absorbido (receta, certificado, firma, presupuesto, anamnesis, pago…): la fusión los anula.',
  })
  absorbedLiveLinks!: LivePublicLinksDto;
}

/** De qué ficha sale cada grupo de datos. Sin indicar: del conservado. */
export class MergeFieldChoicesDto {
  @ApiPropertyOptional({
    enum: MERGE_FIELD_SOURCES,
    enumName: 'MergeFieldSource',
  })
  @IsOptional()
  @IsIn(MERGE_FIELD_SOURCES, {
    message: 'firstName tiene que ser KEPT o ABSORBED.',
  })
  firstName?: MergeFieldSource;
  @ApiPropertyOptional({
    enum: MERGE_FIELD_SOURCES,
    enumName: 'MergeFieldSource',
  })
  @IsOptional()
  @IsIn(MERGE_FIELD_SOURCES, {
    message: 'lastName tiene que ser KEPT o ABSORBED.',
  })
  lastName?: MergeFieldSource;
  @ApiPropertyOptional({
    enum: MERGE_FIELD_SOURCES,
    enumName: 'MergeFieldSource',
    description: 'Tipo, nombre del tipo y número, juntos.',
  })
  @IsOptional()
  @IsIn(MERGE_FIELD_SOURCES, {
    message: 'document tiene que ser KEPT o ABSORBED.',
  })
  document?: MergeFieldSource;
  @ApiPropertyOptional({
    enum: MERGE_FIELD_SOURCES,
    enumName: 'MergeFieldSource',
  })
  @IsOptional()
  @IsIn(MERGE_FIELD_SOURCES, {
    message: 'birthDate tiene que ser KEPT o ABSORBED.',
  })
  birthDate?: MergeFieldSource;
  @ApiPropertyOptional({
    enum: MERGE_FIELD_SOURCES,
    enumName: 'MergeFieldSource',
  })
  @IsOptional()
  @IsIn(MERGE_FIELD_SOURCES, { message: 'sex tiene que ser KEPT o ABSORBED.' })
  sex?: MergeFieldSource;
  @ApiPropertyOptional({
    enum: MERGE_FIELD_SOURCES,
    enumName: 'MergeFieldSource',
  })
  @IsOptional()
  @IsIn(MERGE_FIELD_SOURCES, {
    message: 'phone tiene que ser KEPT o ABSORBED.',
  })
  phone?: MergeFieldSource;
  @ApiPropertyOptional({
    enum: MERGE_FIELD_SOURCES,
    enumName: 'MergeFieldSource',
  })
  @IsOptional()
  @IsIn(MERGE_FIELD_SOURCES, {
    message: 'email tiene que ser KEPT o ABSORBED.',
  })
  email?: MergeFieldSource;
  @ApiPropertyOptional({
    enum: MERGE_FIELD_SOURCES,
    enumName: 'MergeFieldSource',
    description: 'Dirección, país y ciudad, juntos.',
  })
  @IsOptional()
  @IsIn(MERGE_FIELD_SOURCES, {
    message: 'address tiene que ser KEPT o ABSORBED.',
  })
  address?: MergeFieldSource;
  @ApiPropertyOptional({
    enum: MERGE_FIELD_SOURCES,
    enumName: 'MergeFieldSource',
  })
  @IsOptional()
  @IsIn(MERGE_FIELD_SOURCES, {
    message: 'maritalStatus tiene que ser KEPT o ABSORBED.',
  })
  maritalStatus?: MergeFieldSource;
  @ApiPropertyOptional({
    enum: MERGE_FIELD_SOURCES,
    enumName: 'MergeFieldSource',
  })
  @IsOptional()
  @IsIn(MERGE_FIELD_SOURCES, {
    message: 'occupation tiene que ser KEPT o ABSORBED.',
  })
  occupation?: MergeFieldSource;
  @ApiPropertyOptional({
    enum: MERGE_FIELD_SOURCES,
    enumName: 'MergeFieldSource',
    description: 'Nombre y teléfono del médico, juntos.',
  })
  @IsOptional()
  @IsIn(MERGE_FIELD_SOURCES, {
    message: 'physician tiene que ser KEPT o ABSORBED.',
  })
  physician?: MergeFieldSource;
  @ApiPropertyOptional({
    enum: MERGE_FIELD_SOURCES,
    enumName: 'MergeFieldSource',
    description:
      'Nombre, parentesco y teléfono del contacto de emergencia, juntos.',
  })
  @IsOptional()
  @IsIn(MERGE_FIELD_SOURCES, {
    message: 'emergencyContact tiene que ser KEPT o ABSORBED.',
  })
  emergencyContact?: MergeFieldSource;
  @ApiPropertyOptional({
    enum: MERGE_FIELD_SOURCES,
    enumName: 'MergeFieldSource',
  })
  @IsOptional()
  @IsIn(MERGE_FIELD_SOURCES, {
    message: 'notes tiene que ser KEPT o ABSORBED.',
  })
  notes?: MergeFieldSource;
  @ApiPropertyOptional({
    enum: MERGE_FIELD_SOURCES,
    enumName: 'MergeFieldSource',
  })
  @IsOptional()
  @IsIn(MERGE_FIELD_SOURCES, {
    message: 'preferredLanguage tiene que ser KEPT o ABSORBED.',
  })
  preferredLanguage?: MergeFieldSource;
}

/** `POST /patient-duplicates/merge`. */
export class MergePatientsDto {
  @ApiProperty({ format: 'uuid', description: 'El paciente que se conserva.' })
  @IsUUID('4', { message: 'keptId debe ser un UUID.' })
  keptId!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'El paciente que se absorbe: todo lo suyo pasa al conservado y queda retirado.',
  })
  @IsUUID('4', { message: 'absorbedId debe ser un UUID.' })
  absorbedId!: string;

  @ApiPropertyOptional({ type: MergeFieldChoicesDto })
  @IsOptional()
  @ValidateNested({ message: 'fields no es válido.' })
  @Type(() => MergeFieldChoicesDto)
  fields?: MergeFieldChoicesDto;
}

export class MergeMovedDto {
  @ApiProperty({ description: 'Tabla de la base (tipo de registro).' })
  table!: string;
  @ApiProperty() count!: number;
}

export class MergeResolvedDto {
  @ApiProperty({
    description:
      'Qué «uno por paciente» se resolvió a favor del conservado (p. ej. coveragesNoLongerPrimary).',
  })
  kind!: string;
  @ApiProperty() count!: number;
}

export class MergeResultDto {
  @ApiProperty({ format: 'uuid', description: 'El paciente que se conserva.' })
  patientId!: string;
  @ApiProperty({ format: 'uuid' }) absorbedPatientId!: string;
  @ApiProperty({ type: [MergeMovedDto] }) moved!: MergeMovedDto[];
  @ApiProperty({ type: [MergeResolvedDto] }) resolved!: MergeResolvedDto[];
  @ApiProperty({ type: LivePublicLinksDto }) revokedLinks!: LivePublicLinksDto;
  @ApiProperty({
    enum: MERGE_FIELD_GROUP_NAMES,
    enumName: 'MergeFieldGroup',
    isArray: true,
  })
  fieldsFromAbsorbed!: MergeFieldGroup[];
}
