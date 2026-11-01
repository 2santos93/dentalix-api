import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ConsentSignerType,
  SignatureRequestType,
  ToothSurface,
} from '@prisma/client';
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

class PublicBudgetLocationDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) address!: string | null;
}

class PublicBudgetPatientDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) document!: string | null;
}

class PublicBudgetAgreementDto {
  @ApiProperty() name!: string;
  @ApiProperty() payerName!: string;
}

class PublicBudgetItemDto {
  @ApiProperty() toothNumber!: string;
  @ApiProperty({ enum: ToothSurface, enumName: 'ToothSurface', isArray: true })
  surfaces!: ToothSurface[];
  @ApiProperty() procedure!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty() unitPrice!: number;
  @ApiProperty() discount!: number;
  @ApiProperty() subtotal!: number;
  @ApiProperty({ type: Number, nullable: true }) listPrice!: number | null;
  @ApiProperty({ type: String, nullable: true })
  agreementName!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'DX-502: moneda ISO 4217 de `listPrice` (la del catálogo, congelada en la foto enviada). Puede no ser la del plan: no se convierte. Null si no se sabe (foto anterior a DX-502 o sedes sin moneda común): no se muestra la cifra.',
  })
  listPriceCurrency!: string | null;
}

class PublicBudgetTotalDto {
  @ApiProperty() currency!: string;
  @ApiProperty() gross!: number;
  @ApiProperty() discount!: number;
  @ApiProperty() net!: number;
  @ApiProperty({
    description:
      'Ahorro por convenio en `currency`. Desde DX-502 no suma los ítems cuyo precio de lista está en otra moneda (o en una desconocida).',
  })
  agreementSaving!: number;
}

/**
 * DX-415: el presupuesto exacto que se envió (la foto, sin ids internos).
 * Importes en `currency`, con el formato de la sede (`location.locale`).
 */
export class PublicBudgetDto {
  @ApiProperty({ description: 'Moneda ISO 4217 del plan' })
  currency!: string;
  @ApiProperty() clinicName!: string;
  @ApiProperty({ type: PublicBudgetLocationDto })
  location!: PublicBudgetLocationDto;
  @ApiProperty({ type: PublicBudgetPatientDto })
  patient!: PublicBudgetPatientDto;
  @ApiProperty({ type: String, nullable: true })
  professionalName!: string | null;
  @ApiProperty({ type: PublicBudgetAgreementDto, nullable: true })
  agreement!: PublicBudgetAgreementDto | null;
  @ApiProperty({ example: '2026-10-31', description: 'YYYY-MM-DD (sede)' })
  issuedOn!: string;
  @ApiProperty({ example: '2026-11-30' }) validUntil!: string;
  @ApiProperty() validityDays!: number;
  @ApiProperty({ type: [PublicBudgetItemDto] }) items!: PublicBudgetItemDto[];
  @ApiProperty({ type: [PublicBudgetTotalDto] })
  totals!: PublicBudgetTotalDto[];
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
  @ApiProperty({
    type: PublicBudgetDto,
    nullable: true,
    description:
      'BUDGET: el presupuesto que se acepta (el texto `body` son sus condiciones); CONSENT: null',
  })
  budget!: PublicBudgetDto | null;
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
