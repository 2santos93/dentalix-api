import { ApiProperty } from '@nestjs/swagger';
import { ConsentSignerType, type DocumentType } from '@prisma/client';
import { DOCUMENT_TYPES } from '../../../patients/domain/document-type';
import {
  DOC_TYPE_LABEL_PROPERTY,
  DOC_TYPE_NAME_DESCRIPTION,
} from '../../../patients/presentation/dto/doc-type-input';

export class ConsentPreviewDto {
  @ApiProperty({ format: 'uuid' })
  templateId!: string;

  @ApiProperty()
  templateVersion!: number;

  @ApiProperty()
  title!: string;

  @ApiProperty({ description: 'Texto con las variables ya resueltas' })
  body!: string;

  @ApiProperty()
  professionalName!: string;
}

export class PatientConsentSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ format: 'uuid' })
  templateId!: string;

  @ApiProperty()
  templateVersion!: number;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  treatmentPlanId!: string | null;

  @ApiProperty()
  title!: string;

  @ApiProperty({ enum: ConsentSignerType })
  signerType!: ConsentSignerType;

  @ApiProperty()
  signerName!: string;

  @ApiProperty({ type: String, nullable: true })
  signerDocument!: string | null;

  @ApiProperty()
  professionalName!: string;

  @ApiProperty({
    description: 'SHA-256 (hex) de texto + firmante + firmas + signedAt',
  })
  contentHash!: string;

  @ApiProperty({ format: 'date-time', description: 'Hora del servidor' })
  signedAt!: Date;

  @ApiProperty({ format: 'uuid' })
  recordedById!: string;
}

export class PatientConsentDto extends PatientConsentSummaryDto {
  @ApiProperty({ description: 'Texto renderizado tal como se firmó' })
  body!: string;

  @ApiProperty({ description: 'data:image/png;base64,…' })
  patientSignature!: string;

  @ApiProperty({ description: 'data:image/png;base64,…' })
  professionalSignature!: string;
}

class ConsentClinicDto {
  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;
}

class ConsentPatientDto {
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
}

export class PatientConsentDocumentDto extends PatientConsentDto {
  @ApiProperty({ type: ConsentClinicDto })
  clinic!: ConsentClinicDto;

  @ApiProperty({ type: ConsentPatientDto })
  patient!: ConsentPatientDto;

  @ApiProperty({
    description: 'true si el hash guardado coincide con el recalculado al leer',
  })
  integrityOk!: boolean;
}
