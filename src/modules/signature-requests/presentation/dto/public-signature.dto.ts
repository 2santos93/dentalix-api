import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConsentSignerType, SignatureRequestType } from '@prisma/client';
import {
  Equals,
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { SIGNATURE_MAX_CHARS } from '../../../consents/presentation/dto/sign-patient-consent.dto';

class PublicSignatureClinicDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) logoUrl!: string | null;
  @ApiProperty({ type: String, nullable: true }) primaryColor!: string | null;
}

class PublicSignatureLocationDto {
  @ApiProperty({ description: 'Zona IANA de la sede' }) timeZone!: string;
  @ApiProperty({ type: String, nullable: true }) locale!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: ['h12', 'h23'] })
  hourCycle!: string | null;
}

/** Estado mínimo del enlace: sin documento, sin nombres del paciente. */
export class PublicSignatureDto {
  @ApiProperty({ enum: SignatureRequestType, enumName: 'SignatureRequestType' })
  type!: SignatureRequestType;
  @ApiProperty({ type: PublicSignatureClinicDto })
  clinic!: PublicSignatureClinicDto;
  @ApiProperty({ type: PublicSignatureLocationDto })
  location!: PublicSignatureLocationDto;
  @ApiProperty({ description: 'Adónde va el código (an***@dominio)' })
  destinationMasked!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: Date;
  @ApiProperty({ description: 'Hay un código vigente enviado' })
  codeSent!: boolean;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Desde cuándo se puede pedir otro código (null = ya)',
  })
  resendAvailableAt!: Date | null;
  @ApiProperty() codeSendsLeft!: number;
}

export class VerifySignatureCodeDto {
  @ApiProperty({ example: '012345', description: '6 dígitos' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'El código son 6 dígitos.' })
  code!: string;
}

export class SignatureSessionDto {
  @ApiProperty({
    description:
      'Sesión de este navegador: se manda en la cabecera X-Signature-Session para ver y firmar el documento. Solo se guarda su hash.',
  })
  sessionToken!: string;
  @ApiProperty({ format: 'date-time' }) sessionExpiresAt!: Date;
}

export class PublicSignatureDocumentDto {
  @ApiProperty({ enum: SignatureRequestType, enumName: 'SignatureRequestType' })
  type!: SignatureRequestType;
  @ApiProperty() title!: string;
  @ApiProperty({ description: 'El texto exacto que se firma' }) body!: string;
  @ApiProperty({ type: Number, nullable: true })
  templateVersion!: number | null;
  @ApiProperty({ enum: ConsentSignerType, enumName: 'ConsentSignerType' })
  signerType!: ConsentSignerType;
  @ApiProperty() signerName!: string;
  @ApiProperty({
    description:
      'Firma un responsable sin documento registrado: debe escribirlo al firmar',
  })
  signerDocumentRequired!: boolean;
  @ApiProperty() professionalName!: string;
  @ApiProperty({ format: 'date-time' }) sentAt!: Date;
  @ApiProperty({ format: 'date-time' }) expiresAt!: Date;
  @ApiProperty({ type: PublicSignatureClinicDto })
  clinic!: PublicSignatureClinicDto;
  @ApiProperty({ type: PublicSignatureLocationDto })
  location!: PublicSignatureLocationDto;
}

export class SignPublicSignatureDto {
  @ApiProperty({
    description: 'PNG (data:image/png;base64,… o base64), máx. 200 KB.',
  })
  @IsString()
  @MaxLength(SIGNATURE_MAX_CHARS)
  signature!: string;

  @ApiPropertyOptional({
    maxLength: 60,
    description: 'Documento del responsable si el enlace no lo trae',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  signerDocument?: string;

  @ApiProperty({
    description: 'Confirma que leyó el documento completo (debe ser true)',
  })
  @IsBoolean()
  @Equals(true, {
    message: 'Confirma que leíste el documento completo antes de firmar.',
  })
  accepted!: boolean;
}

export class PublicSignedCopyDto extends PublicSignatureDocumentDto {
  @ApiProperty({ type: String, nullable: true })
  signerDocument!: string | null;
  @ApiProperty({ format: 'date-time', description: 'Hora del servidor' })
  signedAt!: Date;
  @ApiProperty({ description: 'SHA-256 de lo firmado y sus evidencias' })
  contentHash!: string;
}
