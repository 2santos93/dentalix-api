import { ApiProperty } from '@nestjs/swagger';
import { ClinicalDiagnosisKind } from '@prisma/client';
import { ClinicalEntryAddendumDto } from './clinical-entry-addendum.dto';

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
