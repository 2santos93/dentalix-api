import { ApiProperty } from '@nestjs/swagger';
import { ClinicCountry, PrescriptionStatus } from '@prisma/client';

export class AllergyMatchDto {
  @ApiProperty({ example: 'Amoxicilina' })
  activeIngredient!: string;

  @ApiProperty({
    example: 'Penicilina',
    description: 'Alergia de la anamnesis',
  })
  allergen!: string;
}

/** Cuerpo del 409 por alerta de alergia. */
export class AllergyConflictDto {
  @ApiProperty({ example: 409 })
  statusCode!: number;

  @ApiProperty()
  message!: string;

  @ApiProperty({ type: [AllergyMatchDto] })
  allergyMatches!: AllergyMatchDto[];
}

export class PrescriptionItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() position!: number;
  @ApiProperty() activeIngredient!: string;
  @ApiProperty({ type: String, nullable: true }) brandName!: string | null;
  @ApiProperty() concentration!: string;
  @ApiProperty() pharmaceuticalForm!: string;
  @ApiProperty() route!: string;
  @ApiProperty() dose!: string;
  @ApiProperty() frequency!: string;
  @ApiProperty() durationDays!: number;
  @ApiProperty() totalQuantity!: number;
  @ApiProperty() quantityUnit!: string;
  @ApiProperty({ example: 'veintiuno' }) quantityInWords!: string;
  @ApiProperty({ type: Number, nullable: true }) packages!: number | null;
  @ApiProperty({ type: String, nullable: true }) instructions!: string | null;
}

export class PrescriptionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) tenantId!: string;
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({ format: 'uuid' }) professionalId!: string;
  @ApiProperty({ enum: ClinicCountry, enumName: 'ClinicCountry' })
  country!: ClinicCountry;
  @ApiProperty({ enum: PrescriptionStatus, enumName: 'PrescriptionStatus' })
  status!: PrescriptionStatus;
  @ApiProperty({ format: 'date-time', description: 'Hora del servidor' })
  issuedAt!: Date;
  @ApiProperty({ format: 'date', example: '2026-10-16' })
  dispensationDate!: string;
  @ApiProperty({
    format: 'date',
    description: 'Último día en que la receta vale',
  })
  validUntil!: string;
  @ApiProperty() patientName!: string;
  @ApiProperty({ type: String, nullable: true }) patientDocument!:
    string | null;
  @ApiProperty({ type: Number, nullable: true }) patientBirthYear!:
    number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Nº de historia clínica',
  })
  clinicalRecordNumber!: string | null;
  @ApiProperty() professionalName!: string;
  @ApiProperty({
    description: 'Registro profesional (CO) / nº de colegiado (ES)',
  })
  professionalLicense!: string;
  @ApiProperty({ type: String, nullable: true }) professionalEmail!:
    string | null;
  @ApiProperty() clinicName!: string;
  @ApiProperty() locationName!: string;
  @ApiProperty({ type: String, nullable: true }) locationAddress!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ description: 'El profesional confirmó una alerta de alergia' })
  allergyOverride!: boolean;
  @ApiProperty({ type: [AllergyMatchDto] }) allergyMatches!: AllergyMatchDto[];
  @ApiProperty({ description: 'SHA-256 (hex) del contenido emitido' })
  contentHash!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  voidedAt!: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) voidedById!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) voidedByName!: string | null;
  @ApiProperty({ type: String, nullable: true }) voidReason!: string | null;
  @ApiProperty({ type: [PrescriptionItemDto] }) items!: PrescriptionItemDto[];
}

export class PrescriptionDocumentDto extends PrescriptionDto {
  @ApiProperty({ type: String, nullable: true }) clinicLogoUrl!: string | null;
  @ApiProperty({
    description: 'true si el hash guardado coincide con el recalculado al leer',
  })
  integrityOk!: boolean;
}

export class PrescriptionIssuerDto {
  @ApiProperty({ enum: ClinicCountry, enumName: 'ClinicCountry' })
  country!: ClinicCountry;
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty() locationName!: string;
  @ApiProperty({ type: String, nullable: true }) locationAddress!:
    string | null;
  @ApiProperty() clinicName!: string;
  @ApiProperty() professionalName!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'null = hay que pedirlo en el modal',
  })
  professionalLicense!: string | null;
  @ApiProperty({ description: 'Días naturales de validez (ES 10, CO 30)' })
  validityDays!: number;
  @ApiProperty({ description: 'Medicamentos por receta (ES 1, CO 10)' })
  maxItems!: number;
}
