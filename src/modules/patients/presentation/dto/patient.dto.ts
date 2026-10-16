import { ApiProperty } from '@nestjs/swagger';
import { DocType, Sex } from '@prisma/client';

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

  @ApiProperty({ type: String, nullable: true })
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

  @ApiProperty({ type: String, nullable: true })
  guardianName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  guardianDocNumber!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}
