import { DocumentRegionalDto } from '../../../../shared/locations/document-regional.dto';
import { ClinicFiscalDto } from '../../../../shared/clinic/clinic-fiscal.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ConsentSignerType,
  ExpiredQuoteAcceptanceMode,
  ExpiredQuoteAcceptanceReason,
  SignatureRequestChannel,
  ToothSurface,
  TreatmentPlanStatus,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { RepricingPreviewDto } from './plan-repricing.dto';

// Margen sobre el base64 de 200 KB (273068) para el prefijo `data:`; el tope
// exacto y el formato PNG los valida el caso de uso (parseSignaturePng).
const SIGNATURE_MAX_CHARS = 273200;

/**
 * DX-379 (C): cómo aceptar un presupuesto VENCIDO. Solo se envía si el plan
 * tiene `quoteExpired: true` (si no, 400).
 */
export class ExpiredAcceptanceDto {
  @ApiProperty({
    enum: ExpiredQuoteAcceptanceMode,
    enumName: 'ExpiredQuoteAcceptanceMode',
    description:
      'REPRICE: actualizar los precios de TODOS los ítems propuestos antes de firmar (exige `repricePreviewHash`; `contentHash` es el del presupuesto recotizado de POST …/acceptance/reprice-preview). ORIGINAL_PRICES: aceptar con los precios del presupuesto vencido (exige `reason`).',
  })
  @IsEnum(ExpiredQuoteAcceptanceMode, {
    message:
      'Elige cómo aceptar el presupuesto vencido: actualizar los precios o mantener los originales.',
  })
  mode!: ExpiredQuoteAcceptanceMode;

  @ApiPropertyOptional({
    enum: ExpiredQuoteAcceptanceReason,
    enumName: 'ExpiredQuoteAcceptanceReason',
    description:
      'Motivo de ORIGINAL_PRICES (obligatorio). OTHER exige `note`. Con REPRICE no se envía.',
  })
  @IsOptional()
  @IsEnum(ExpiredQuoteAcceptanceReason, {
    message:
      'Elige el motivo: la clínica tardó en cerrarlo, se mantuvo el precio pactado, paciente habitual, situación económica u otro.',
  })
  reason?: ExpiredQuoteAcceptanceReason;

  @ApiPropertyOptional({
    maxLength: 200,
    example: 'Se respetó el precio acordado en la primera consulta',
    description: 'Obligatoria con OTHER. Con REPRICE no se envía.',
  })
  @IsOptional()
  @IsString({ message: 'La nota del motivo debe ser un texto.' })
  @MaxLength(200, {
    message: 'La nota del motivo admite hasta 200 caracteres.',
  })
  note?: string;

  @ApiPropertyOptional({
    pattern: '^[0-9a-f]{64}$',
    description:
      'REPRICE: el `repricing.previewHash` de POST …/acceptance/reprice-preview. Si los precios vigentes cambiaron desde entonces: 409 `REPRICE_PREVIEW_STALE`.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-fA-F]{64}$/, {
    message: 'repricePreviewHash debe ser un SHA-256 en hexadecimal',
  })
  repricePreviewHash?: string;
}

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

  @ApiPropertyOptional({
    type: ExpiredAcceptanceDto,
    description:
      'DX-379 (C): obligatorio si el presupuesto está vencido (sin él: 409 `QUOTE_EXPIRED`); con un presupuesto no vencido: 400.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ExpiredAcceptanceDto)
  expired?: ExpiredAcceptanceDto;
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

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'DX-502: moneda ISO 4217 de `listPrice`, la del catálogo al dar de alta el ítem (congelada; en v1/v2/v3, la guardada en el ítem). Puede no ser la del plan: no se convierte. Null si no se sabe: la web oculta la cifra y pone la nota de referencia.',
  })
  listPriceCurrency!: string | null;
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
      'Ahorro por convenio (v2): Σ max(0, precio de lista − precio de referencia) de los ítems con convenio, en la moneda del plan. v4 (DX-502): solo los ítems cuyo precio de lista está en la moneda del plan (nunca resta monedas distintas). 0 en v1.',
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
    description:
      'Quien registró la firma (usuario de la clínica). A distancia (DX-514): quien envió el enlace; el firmante es `signerName`.',
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

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: '2026-11-03',
    description:
      'DX-379 (C): último día válido del presupuesto al firmar (antes de actualizar precios). Null en aceptaciones anteriores o sin validez guardada. Fuera del contenido firmado.',
  })
  quoteValidUntil!: string | null;

  @ApiProperty({
    enum: ExpiredQuoteAcceptanceMode,
    enumName: 'ExpiredQuoteAcceptanceMode',
    nullable: true,
    description:
      'DX-379 (C): null si el presupuesto no estaba vencido. ORIGINAL_PRICES: «Aceptado con los precios del presupuesto vencido el {quoteValidUntil}. Motivo: {expiredReason}[: {expiredNote}]». REPRICE: «Precios actualizados el {acceptedAt} antes de aceptar».',
  })
  expiredMode!: ExpiredQuoteAcceptanceMode | null;

  @ApiProperty({
    enum: ExpiredQuoteAcceptanceReason,
    enumName: 'ExpiredQuoteAcceptanceReason',
    nullable: true,
    description: 'Motivo de ORIGINAL_PRICES; null en el resto.',
  })
  expiredReason!: ExpiredQuoteAcceptanceReason | null;

  @ApiProperty({ type: String, nullable: true })
  expiredNote!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'REPRICE: la recotización hecha en la firma (treatment_plan_repricings, source ACCEPT).',
  })
  repricingId!: string | null;
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
  // DX-514: quién firmó por el enlace, el paciente o su representante
  // (`signerName`). Sin `description`: con `enumName` se la pondría al enum
  // compartido del contrato.
  @ApiPropertyOptional({
    enum: ConsentSignerType,
    enumName: 'ConsentSignerType',
  })
  signerType?: ConsentSignerType;
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
    enum: [1, 2, 3, 4],
    description:
      '4 = con la moneda de cada precio de lista (DX-502) y los datos fiscales congelados si la clínica los tiene; 3 = con datos fiscales congelados (DX-019); 2 = con convenio y ahorro (DX-105); 1 = foto firmada antes de DX-105 (sin convenio).',
  })
  version!: 1 | 2 | 3 | 4;

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
    nullable: true,
    description:
      'DX-019: datos fiscales. Aceptado: los congelados al firmar; null si no los llevaba (nunca los de hoy).',
  })
  clinicFiscal!: ClinicFiscalDto | null;

  @ApiProperty({ type: PlanQuoteLocationDto })
  location!: PlanQuoteLocationDto;

  @ApiProperty({
    type: DocumentRegionalDto,
    nullable: true,
    description:
      'DX-354: zona, locale y reloj de la sede del presupuesto (la de la firma si ya se aceptó). null si le falta algo: el presupuesto se lee igual y la web pinta «—». No forma parte del contenido firmado.',
  })
  regional!: DocumentRegionalDto | null;

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

/**
 * DX-379 (C): vista previa de «actualizar los precios» al aceptar un
 * presupuesto vencido. No escribe nada.
 */
export class AcceptanceRepricePreviewDto {
  @ApiProperty({
    type: RepricingPreviewDto,
    description:
      'La recotización de todos los ítems propuestos. Su `previewHash` va en `expired.repricePreviewHash` de la aceptación.',
  })
  repricing!: RepricingPreviewDto;

  @ApiProperty({
    type: PlanQuoteDocumentDto,
    description:
      'El presupuesto como se firmaría, con los precios y la validez nuevos. Su `contentHash` va en `contentHash` de la aceptación.',
  })
  quote!: PlanQuoteDocumentDto;
}
