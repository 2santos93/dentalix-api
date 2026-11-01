import { ClinicFiscalDto } from '../../../../shared/clinic/clinic-fiscal.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  SignatureRequestChannel,
  ToothSurface,
  TreatmentPlanStatus,
} from '@prisma/client';
import { IsString, Matches, MaxLength } from 'class-validator';

// Margen sobre el base64 de 200 KB (273068) para el prefijo `data:`; el tope
// exacto y el formato PNG los valida el caso de uso (parseSignaturePng).
const SIGNATURE_MAX_CHARS = 273200;

// Sin `acceptedAt`, autor, sede, IP ni UA: los pone el servidor.
export class AcceptTreatmentPlanDto {
  @ApiProperty({
    maxLength: 200,
    description: 'Nombre de quien firma (el paciente o su representante)',
  })
  @IsString()
  @MaxLength(200)
  signerName!: string;

  @ApiProperty({
    description:
      'Firma en PNG (data:image/png;base64,… o base64), máx. 200 KB. Vacía: 400.',
  })
  @IsString()
  @MaxLength(SIGNATURE_MAX_CHARS)
  signature!: string;

  @ApiProperty({
    description:
      'El contentHash del presupuesto que se mostró (GET …/quote). Si el presupuesto cambió desde entonces: 409.',
    pattern: '^[0-9a-f]{64}$',
  })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/, {
    message: 'contentHash debe ser un SHA-256 en hexadecimal',
  })
  contentHash!: string;
}

export class PlanQuoteLocationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  address!: string | null;
}

export class PlanQuotePatientDto {
  @ApiProperty()
  name!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Documento nacional DOC-0001',
  })
  document!: string | null;
}

export class PlanQuoteItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Diente FDI' })
  toothNumber!: string;

  @ApiProperty({ enum: ToothSurface, isArray: true })
  surfaces!: ToothSurface[];

  @ApiProperty({
    description: 'Nombre del procedimiento (catálogo, en español)',
  })
  procedure!: string;

  @ApiProperty({
    description: 'Siempre 1: un ítem es un procedimiento sobre un diente',
  })
  quantity!: number;

  @ApiProperty()
  unitPrice!: number;

  @ApiProperty()
  discount!: number;

  @ApiProperty({ description: 'unitPrice × quantity − discount' })
  subtotal!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Precio de catálogo del procedimiento al añadirlo (v2). Null en ítems anteriores a DX-105 y en presupuestos v1.',
  })
  listPrice!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Convenio con que se fijó el precio del ítem (v2). Null si no hubo convenio.',
  })
  agreementName!: string | null;
}

export class PlanQuoteTotalDto {
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({ description: 'Σ precios' })
  gross!: number;

  @ApiProperty({ description: 'Σ descuentos' })
  discount!: number;

  @ApiProperty({ description: 'gross − discount' })
  net!: number;

  @ApiProperty({
    description:
      'Ahorro por convenio (v2): Σ max(0, precio de lista − precio de referencia) de los ítems con convenio, en la moneda del plan. 0 en v1.',
  })
  agreementSaving!: number;
}

export class PlanQuoteAgreementDto {
  @ApiProperty({
    description:
      'Nombre del convenio; si el plan mezcla varios, los nombres separados por « · ».',
  })
  name!: string;

  @ApiProperty({ description: 'Pagador del primer convenio' })
  payerName!: string;
}

export class PlanQuoteAcceptanceDto {
  @ApiProperty()
  signerName!: string;

  @ApiProperty({ description: 'data:image/png;base64,…' })
  signature!: string;

  @ApiProperty({ format: 'date-time', description: 'Hora del servidor' })
  acceptedAt!: Date;

  @ApiProperty({
    description: 'Quien registró la firma (usuario de la clínica)',
  })
  acceptedByName!: string;

  @ApiProperty({
    description: 'SHA-256 de contentHash + firmante + firma + hora',
  })
  acceptanceHash!: string;

  @ApiProperty({
    description:
      'false si la foto o la firma guardadas no coinciden con sus hashes',
  })
  integrityOk!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'IP desde la que se firmó (evidencia)',
  })
  ipAddress!: string | null;

  @ApiProperty({ type: String, nullable: true })
  userAgent!: string | null;

  @ApiProperty({
    type: () => PlanQuoteRemoteAcceptanceDto,
    nullable: true,
    description:
      'DX-415: «Aceptado a distancia» por el paciente con enlace y código; null si se firmó en la clínica.',
  })
  remote!: PlanQuoteRemoteAcceptanceDto | null;
}

/** Evidencias de la aceptación a distancia (DX-415), congeladas al firmar. */
export class PlanQuoteRemoteAcceptanceDto {
  @ApiProperty({ format: 'uuid' }) signatureRequestId!: string;
  @ApiProperty({
    enum: SignatureRequestChannel,
    enumName: 'SignatureRequestChannel',
  })
  channel!: SignatureRequestChannel;
  @ApiProperty({ description: 'Destino enmascarado (an***@dominio)' })
  destinationMasked!: string;
  @ApiProperty({ format: 'date-time' }) sentAt!: Date;
  @ApiProperty({ format: 'date-time' }) openedAt!: Date;
  @ApiProperty({ format: 'date-time' }) verifiedAt!: Date;
}

/**
 * Presupuesto imprimible del plan (DX-012). Sin aceptación, es el plan VIVO
 * emitido hoy; aceptado, es la foto firmada (no cambia aunque cambie el plan).
 */
export class PlanQuoteVisitDto {
  @ApiProperty({ format: 'uuid' }) itemId!: string;
  @ApiProperty() visit!: number;
  @ApiProperty({ type: String, nullable: true }) label!: string | null;
  @ApiProperty() minDaysAfterPrevious!: number;
}
export class PlanQuoteDocumentDto {
  @ApiPropertyOptional({
    type: [PlanQuoteVisitDto],
    description: 'Organización clínica actual; separada del contenido firmado.',
  })
  visitOrganization?: PlanQuoteVisitDto[];

  @ApiProperty({
    enum: [1, 2],
    description:
      '2 = con convenio y ahorro (DX-105); 1 = foto firmada antes de DX-105 (sin convenio).',
  })
  version!: 1 | 2;

  @ApiProperty({ format: 'uuid' })
  planId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ enum: TreatmentPlanStatus })
  planStatus!: TreatmentPlanStatus;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty()
  clinicName!: string;

  @ApiProperty({ type: String, nullable: true })
  clinicLogoUrl!: string | null;

  @ApiProperty({
    type: ClinicFiscalDto,
    description:
      'DX-019: datos fiscales de HOY (no forman parte del contenido firmado).',
  })
  clinicFiscal!: ClinicFiscalDto;

  @ApiProperty({ type: PlanQuoteLocationDto })
  location!: PlanQuoteLocationDto;

  @ApiProperty({ type: PlanQuotePatientDto })
  patient!: PlanQuotePatientDto;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Profesional que creó el plan',
  })
  professionalName!: string | null;

  @ApiProperty({
    type: PlanQuoteAgreementDto,
    nullable: true,
    description: 'Convenio de los ítems; null si ninguno lo tiene',
  })
  agreement!: PlanQuoteAgreementDto | null;

  @ApiProperty({
    example: '2026-10-16',
    description: 'Fecha de emisión (zona de la sede)',
  })
  issuedOn!: string;

  @ApiProperty({ example: '2026-11-15' })
  validUntil!: string;

  @ApiProperty({ example: 30 })
  validityDays!: number;

  @ApiProperty({ type: [PlanQuoteItemDto] })
  items!: PlanQuoteItemDto[];

  @ApiProperty({
    type: [PlanQuoteTotalDto],
    description: 'Una fila por moneda',
  })
  totals!: PlanQuoteTotalDto[];

  @ApiProperty({ description: 'SHA-256 del contenido presentado' })
  contentHash!: string;

  @ApiProperty({ type: PlanQuoteAcceptanceDto, nullable: true })
  acceptance!: PlanQuoteAcceptanceDto | null;
}
