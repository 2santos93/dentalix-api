import { ApiProperty } from '@nestjs/swagger';
import { ClinicalDiagnosisKind } from '@prisma/client';
import { ClinicalEntryAddendumDto } from './clinical-entry-addendum.dto';
import { ItemRecallUpdateDto } from '../../../treatment-plans/presentation/dto/treatment-plan-item.dto';
import {
  CLINICAL_ENTRY_WARNING_CODES,
  type ClinicalEntryWarningCode,
} from '../../domain/author-license';

/** DX-170: la cita en la que se documentó la evolución. */
export class ClinicalEntryAppointmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'date-time' })
  start!: Date;

  @ApiProperty({ format: 'uuid' })
  providerId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Nombre del profesional de la cita (null si ya no es de la clínica)',
  })
  providerName!: string | null;
}

/** DX-212: diagnóstico CIE-10 guardado con la evolución. */
export class ClinicalEntryDiagnosisDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'K02.1' })
  icd10Code!: string;

  @ApiProperty({ example: 'Caries de la dentina' })
  labelEs!: string;

  @ApiProperty({
    enum: ClinicalDiagnosisKind,
    enumName: 'ClinicalDiagnosisKind',
  })
  kind!: ClinicalDiagnosisKind;

  @ApiProperty({ type: String, nullable: true, example: '36' })
  toothFdi!: string | null;

  @ApiProperty({ description: '0 = principal; 1..3 = relacionados' })
  position!: number;
}

// Response shape for ClinicalEntry endpoints — documents the ClinicalEntry
// entity contract for Swagger (same convention as BrandingDto /
// StaffMemberDto). The use cases already return values shaped exactly like
// this (ClinicalEntry entity, see
// ../../domain/entities/clinical-entry.entity.ts); this class exists purely
// for `@ApiProperty` documentation, not for input validation.
export class ClinicalEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ format: 'date-time' })
  entryDate!: Date;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;

  @ApiProperty()
  notes!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  performedById!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'RP-12345',
    description:
      'DX-540: registro profesional del autor congelado al firmar (inalterable). null si no lo tenía o en evoluciones anteriores.',
  })
  authorProfessionalLicense!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'DX-170: cita ligada (null en las evoluciones sueltas)',
  })
  appointmentId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'DX-170: plantilla con la que se redactó (solo procedencia; el texto está en notes)',
  })
  templateId!: string | null;

  @ApiProperty({ type: ClinicalEntryAppointmentDto, nullable: true })
  appointment!: ClinicalEntryAppointmentDto | null;

  @ApiProperty({
    format: 'date-time',
    description: 'Fecha de registro: la fija el servidor',
  })
  createdAt!: Date;

  @ApiProperty({
    type: [ClinicalEntryAddendumDto],
    description: 'Adendas de corrección, en orden cronológico (DX-038)',
  })
  addenda!: ClinicalEntryAddendumDto[];

  @ApiProperty({
    type: [ClinicalEntryDiagnosisDto],
    description:
      'DX-212: diagnósticos CIE-10, el principal primero (vacío en las evoluciones sin diagnóstico)',
  })
  diagnoses!: ClinicalEntryDiagnosisDto[];
}

/** DX-540: aviso de la firma de una evolución (no bloquea). */
export class ClinicalEntryWarningDto {
  @ApiProperty({
    enum: CLINICAL_ENTRY_WARNING_CODES,
    enumName: 'ClinicalEntryWarningCode',
    description:
      'PROFESSIONAL_LICENSE_MISSING: la clínica avisa y el autor firmó sin registro profesional.',
  })
  code!: ClinicalEntryWarningCode;

  @ApiProperty({ description: 'Texto en español para mostrarlo tal cual' })
  message!: string;
}

/** Respuesta del alta: la evolución firmada y los avisos de la firma (DX-540). */
export class CreatedClinicalEntryDto extends ClinicalEntryDto {
  @ApiProperty({
    type: [ClinicalEntryWarningDto],
    description:
      'DX-540: avisos de la firma; vacío si no hay nada que avisar. No se guardan con la evolución.',
  })
  warnings!: ClinicalEntryWarningDto[];

  @ApiProperty({
    type: [ItemRecallUpdateDto],
    description:
      'DX-015-bis (D18): con `recall`, el recall que fijó la evolución (creado, con otro intervalo o reactivado) y, tras él, los que la exclusión desactivó (`deactivated: true`); vacío sin `recall`.',
  })
  recallUpdates!: ItemRecallUpdateDto[];
}
