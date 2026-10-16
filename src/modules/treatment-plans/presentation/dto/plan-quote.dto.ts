import { ApiProperty } from '@nestjs/swagger';
import { ToothSurface, TreatmentPlanStatus } from '@prisma/client';
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

  @ApiProperty({ type: String, nullable: true, example: 'CC 1020304050' })
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
}

export class PlanQuoteTotalDto {
  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({ description: 'Σ precios' })
  gross!: number;

  @ApiProperty({ description: 'Σ descuentos' })
  discount!: number;

  @ApiProperty({ description: 'gross − discount' })
  net!: number;
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
}

/**
 * Presupuesto imprimible del plan (DX-012). Sin aceptación, es el plan VIVO
 * emitido hoy; aceptado, es la foto firmada (no cambia aunque cambie el plan).
 */
export class PlanQuoteDocumentDto {
  @ApiProperty({ enum: [1] })
  version!: 1;

  @ApiProperty({ format: 'uuid' })
  planId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ enum: TreatmentPlanStatus })
  planStatus!: TreatmentPlanStatus;

  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty()
  clinicName!: string;

  @ApiProperty({ type: String, nullable: true })
  clinicLogoUrl!: string | null;

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
