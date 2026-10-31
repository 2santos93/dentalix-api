import { ApiProperty } from '@nestjs/swagger';
import {
  ConsentSignerType,
  SignatureRequestChannel,
  type DocumentType,
} from '@prisma/client';
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

/** DX-243: evidencias congeladas de la firma del paciente a distancia. */
export class RemoteConsentEvidenceDto {
  @ApiProperty({ format: 'uuid' })
  signatureRequestId!: string;

  @ApiProperty({
    enum: SignatureRequestChannel,
    enumName: 'SignatureRequestChannel',
  })
  channel!: SignatureRequestChannel;

  @ApiProperty({ description: 'Destino enmascarado (an***@dominio)' })
  destinationMasked!: string;

  @ApiProperty({ format: 'date-time' })
  sentAt!: Date;

  @ApiProperty({ format: 'date-time' })
  openedAt!: Date;

  @ApiProperty({ format: 'date-time', description: 'Código verificado' })
  verifiedAt!: Date;

  @ApiProperty({
    format: 'uuid',
    description:
      'El profesional que debe firmar en la app (y que nombra el texto)',
  })
  professionalUserId!: string;
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

  @ApiProperty({
    type: RemoteConsentEvidenceDto,
    nullable: true,
    description: 'DX-243: firmado a distancia por enlace; null si en pantalla',
  })
  remote!: RemoteConsentEvidenceDto | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Firma del profesional: la misma hora en pantalla; a distancia, la de su firma en la app (null si falta)',
  })
  professionalSignedAt!: Date | null;

  @ApiProperty({
    description:
      'Completo: con la firma del paciente Y la del profesional. Solo así cuenta como válido.',
  })
  complete!: boolean;
}

export class PatientConsentDto extends PatientConsentSummaryDto {
  @ApiProperty({ description: 'Texto renderizado tal como se firmó' })
  body!: string;

  @ApiProperty({ description: 'data:image/png;base64,…' })
  patientSignature!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'data:image/png;base64,…; null en uno firmado a distancia hasta que firma el profesional',
  })
  professionalSignature!: string | null;
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

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'DX-243: IP desde la que firmó el paciente a distancia (evidencia); null si se firmó en pantalla',
  })
  remoteIpAddress!: string | null;
}
