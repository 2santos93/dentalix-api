import { CoverageSummaryDto } from '../../../patient-coverages/presentation/dto/coverage-summary.dto';
import { OverdueBalanceDto } from '../../../collections/presentation/dto/collections.dto';
import { ApiProperty } from '@nestjs/swagger';
import {
  ContactChannel,
  DocType,
  ReminderOptOutSource,
  RetentionExtension,
  Sex,
  WhatsappOptInSource,
} from '@prisma/client';

// Response shape for Patient endpoints — documents the Patient entity
// contract for Swagger (same convention as BrandingDto / StaffMemberDto).
// The use cases already return values shaped exactly like this (Patient
// entity, see ../../domain/entities/patient.entity.ts); this class exists
// purely for `@ApiProperty` documentation, not for input validation.
export class PatientDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;

  @ApiProperty({ enum: DocType })
  docType!: DocType;

  @ApiProperty({ type: String, nullable: true })
  docNumber!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  birthDate!: Date | null;

  @ApiProperty({ enum: Sex })
  sex!: Sex;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;

  @ApiProperty({ type: String, nullable: true })
  address!: string | null;

  @ApiProperty({ type: String, nullable: true })
  countryCode!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  cityId!: number | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({
    deprecated: true,
    description:
      'DEPRECADO (DX-037): resumen derivado de la última autorización GENERAL. La fuente de verdad es GET /patients/:id/data-consents.',
  })
  dataConsentAccepted!: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    deprecated: true,
    description:
      'DEPRECADO (DX-037): hora (servidor) de la última autorización GENERAL.',
  })
  dataConsentAt!: Date | null;

  @ApiProperty({
    type: String,
    nullable: true,
    deprecated: true,
    description:
      'DEPRECADO (DX-037): versión («v1», «v2»…) de la política de la última autorización GENERAL.',
  })
  dataConsentPolicyVersion!: string | null;

  @ApiProperty({ type: String, nullable: true })
  maritalStatus!: string | null;

  @ApiProperty({ type: String, nullable: true })
  occupation!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    deprecated: true,
    description:
      'DEPRECADO (DX-153): texto libre original, solo lectura. La aseguradora vive ahora en las coberturas del paciente (`/patients/:id/coverages`); enviarlo en POST o PATCH se ignora.',
  })
  insurerEps!: string | null;

  @ApiProperty({ type: String, nullable: true })
  physicianName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  physicianPhone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  emergencyContactName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  emergencyContactRelationship!: string | null;

  @ApiProperty({ type: String, nullable: true })
  emergencyContactPhone!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    deprecated: true,
    description:
      'DEPRECADO (DX-203), solo lectura: el acudiente es ahora un responsable (`GET /patients/:id/responsible-parties`). La migración lo copió allí.',
  })
  guardianName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    deprecated: true,
    description: 'DEPRECADO (DX-203), solo lectura. Ver `guardianName`.',
  })
  guardianDocNumber!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById!: string | null;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description:
      'DX-039: fecha de la última atención clínica (evolución registrada o ' +
      'cita atendida). La mantiene la BD y nunca retrocede.',
  })
  lastAttentionAt!: Date | null;

  @ApiProperty({
    enum: RetentionExtension,
    enumName: 'RetentionExtension',
    description:
      'Retención extendida de la HC: NONE = 15 años desde la última ' +
      'atención (Res. 839/2017), DOUBLE = 30 años, PERMANENT = nunca se ' +
      'libera. Solo ADMIN la cambia.',
  })
  retentionExtended!: RetentionExtension;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: '2039-02-28',
    description:
      'Último día (incluido) en que la HC debe conservarse. null sin ' +
      'atenciones clínicas o con retención PERMANENT.',
  })
  retentionUntil!: string | null;

  @ApiProperty({
    description:
      'Si hoy la HC está en retención legal: archivar o borrar al paciente ' +
      'responde 409 CLINICAL_RECORD_RETENTION.',
  })
  underRetention!: boolean;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description:
      'DX-039: cuándo se vaciaron sus datos no clínicos (supresión parcial).',
  })
  partiallySuppressedAt!: Date | null;

  @ApiProperty({
    enum: ContactChannel,
    enumName: 'ContactChannel',
    description:
      'DX-128: canal de los avisos automáticos (EMAIL, WHATSAPP o NONE). Detalle en GET /patients/:id/communication.',
  })
  contactChannel!: ContactChannel;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  whatsappOptInAt!: Date | null;

  @ApiProperty({
    enum: WhatsappOptInSource,
    enumName: 'WhatsappOptInSource',
    nullable: true,
  })
  whatsappOptInSource!: WhatsappOptInSource | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  whatsappOptInById!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'DX-128: baja de los recordatorios automáticos.',
  })
  reminderOptOutAt!: Date | null;

  @ApiProperty({
    enum: ReminderOptOutSource,
    enumName: 'ReminderOptOutSource',
    nullable: true,
  })
  reminderOptOutSource!: ReminderOptOutSource | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

/**
 * GET /patients/:id (DX-150): la ficha con la marca «Saldo vencido» de su
 * cabecera. El importe (`balance.amounts`) solo llega a ADMIN y RECEPTION.
 * `coverage` (DX-153) resume la cobertura principal, sin número de afiliado.
 */
export class PatientDetailDto extends PatientDto {
  @ApiProperty({ type: OverdueBalanceDto })
  balance!: OverdueBalanceDto;

  @ApiProperty({ type: CoverageSummaryDto })
  coverage!: CoverageSummaryDto;
}

/** Un paciente de GET /patients: la ficha base más el resumen de cobertura (DX-153). */
export class PatientListItemDto extends PatientDto {
  @ApiProperty({ type: CoverageSummaryDto })
  coverage!: CoverageSummaryDto;
}
