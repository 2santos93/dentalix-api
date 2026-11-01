import { ClinicFiscalDto } from '../../../../shared/clinic/clinic-fiscal.dto';
/**
 * Excepción G5.3 (DX-334): recetas emitidas antes de DX-324. `country` es el
 * campo histórico de la plantilla legada; en la receta única viaja `null`.
 */
import { ApiProperty } from '@nestjs/swagger';
import { PrescriptionStatus } from '@prisma/client';
import type { LegacyPrescriptionCountry } from '../../domain/legacy-prescription';

const LEGACY_PRESCRIPTION_COUNTRIES: LegacyPrescriptionCountry[] = ['CO', 'ES'];

export class AllergyMatchDto {
  @ApiProperty({ example: 'Amoxicilina' })
  activeIngredient!: string;

  @ApiProperty({
    example: 'Penicilina',
    description: 'Alergia de la anamnesis',
  })
  allergen!: string;
}

const SAFETY_RULES = [
  'ALLERGY',
  'INTERACTION',
  'PREGNANCY',
  'ANTIRESORPTIVE',
  'PEDIATRIC_DOSE',
  'NO_ANAMNESIS',
];

/** Aviso de seguridad de la receta (DX-300), calculado por el servidor. */
export class SafetyAlertDto {
  @ApiProperty({ enum: SAFETY_RULES, enumName: 'PrescriptionSafetyRule' })
  rule!: string;

  @ApiProperty({
    example: 'INTERACTION_ANTICOAGULANT_NSAID',
    description: 'Referencia estable de la regla (prescription-safety.ts)',
  })
  code!: string;

  @ApiProperty({
    enum: ['BLOCKING', 'INFO'],
    enumName: 'PrescriptionSafetySeverity',
    description: 'BLOCKING exige confirmación y motivo para emitir',
  })
  severity!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Principio activo que lo dispara; null si es general',
  })
  activeIngredient!: string | null;

  @ApiProperty({ description: 'Texto en español para quien prescribe' })
  message!: string;

  @ApiProperty({ example: 'SDCEP, Drug Prescribing for Dentistry' })
  source!: string;
}

/** Cuerpo del 409 por avisos bloqueantes sin confirmar (o sin motivo). */
export class SafetyConflictDto {
  @ApiProperty({ example: 409 })
  statusCode!: number;

  @ApiProperty({ description: 'Mensaje en español con los avisos' })
  message!: string;

  @ApiProperty({ type: [AllergyMatchDto] })
  allergyMatches!: AllergyMatchDto[];

  @ApiProperty({ type: [SafetyAlertDto] })
  safetyAlerts!: SafetyAlertDto[];
}

/** Respuesta de la previsualización de avisos (DX-300). */
export class PrescriptionSafetyPreviewDto {
  @ApiProperty({ example: 'RX_SAFETY_V1' })
  rulesVersion!: string;

  @ApiProperty({
    enum: ['PRESENT', 'MISSING'],
    description: 'MISSING = el paciente no tiene anamnesis',
  })
  anamnesis!: 'PRESENT' | 'MISSING';

  @ApiProperty({ description: 'Hay avisos que exigen confirmación y motivo' })
  hasBlocking!: boolean;

  @ApiProperty({ type: [SafetyAlertDto] })
  alerts!: SafetyAlertDto[];
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
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'veintiuno',
    description:
      'Cantidad total en letras: la guardada en una receta legada; en la receta única, solo si la clínica la imprimía al emitir (si no, null)',
  })
  quantityInWords!: string | null;
  @ApiProperty({ type: Number, nullable: true }) packages!: number | null;
  @ApiProperty({ type: String, nullable: true }) instructions!: string | null;
}

export class PrescriptionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) tenantId!: string;
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({ format: 'uuid' }) professionalId!: string;
  @ApiProperty({
    enum: LEGACY_PRESCRIPTION_COUNTRIES,
    enumName: 'LegacyPrescriptionCountry',
    nullable: true,
    description:
      'Plantilla con la que se emitió una receta anterior a la receta única; null en la receta única',
  })
  country!: LegacyPrescriptionCountry | null;
  @ApiProperty({ enum: PrescriptionStatus, enumName: 'PrescriptionStatus' })
  status!: PrescriptionStatus;
  @ApiProperty({ format: 'date-time', description: 'Hora del servidor' })
  issuedAt!: Date;
  @ApiProperty({
    format: 'date',
    example: '2026-10-16',
    description: 'Fecha desde la que la receta vale',
  })
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
    type: Number,
    nullable: true,
    description:
      'Años cumplidos el día de la emisión en la zona de la sede; null sin fecha de nacimiento, con una edad imposible o en recetas anteriores',
  })
  patientAgeYears!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 72.5,
    description:
      'Peso de la anamnesis vigente al emitir, redondeado a 0,1 kg; null si no consta o en recetas anteriores',
  })
  patientWeightKg!: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Nº de historia clínica',
  })
  clinicalRecordNumber!: string | null;
  @ApiProperty() professionalName!: string;
  @ApiProperty({ description: 'Nº de registro profesional' })
  professionalLicense!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Especialidad del perfil del profesional al emitir; null si no tenía o en recetas anteriores',
  })
  professionalSpecialty!: string | null;
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
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Versión de las reglas de la receta segura (DX-300); null en recetas anteriores',
  })
  safetyRulesVersion!: string | null;
  @ApiProperty({
    type: [SafetyAlertDto],
    nullable: true,
    description:
      'Avisos calculados al emitir (dentro del hash); null en recetas anteriores a DX-300',
  })
  safetyAlerts!: SafetyAlertDto[] | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Motivo con el que se confirmaron los avisos bloqueantes',
  })
  safetyOverrideReason!: string | null;
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

/**
 * Formato ACTUAL de la sede de la receta, también si está retirada; lo que
 * falte llega como null (nunca un 409).
 */
export class PrescriptionLocationFormatDto {
  @ApiProperty({ type: String, nullable: true, example: 'Asia/Tokyo' })
  timeZone!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'ja-JP' })
  locale!: string | null;
  @ApiProperty({
    enum: ['h12', 'h23'],
    enumName: 'PrescriptionHourCycle',
    nullable: true,
  })
  hourCycle!: 'h12' | 'h23' | null;
}

export class PrescriptionDocumentDto extends PrescriptionDto {
  @ApiProperty({ type: String, nullable: true }) clinicLogoUrl!: string | null;
  @ApiProperty({
    type: ClinicFiscalDto,
    description:
      'DX-019: datos fiscales de HOY (no forman parte del hash de la receta).',
  })
  clinicFiscal!: ClinicFiscalDto;
  @ApiProperty({
    type: PrescriptionLocationFormatDto,
    description:
      'Formato regional y zona actuales de la sede de la receta, para imprimirla',
  })
  locationFormat!: PrescriptionLocationFormatDto;
  @ApiProperty({
    description: 'true si el hash guardado coincide con el recalculado al leer',
  })
  integrityOk!: boolean;
}

export class PrescriptionIssuerDto {
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
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Especialidad del perfil; se imprime si existe',
  })
  professionalSpecialty!: string | null;
  @ApiProperty({
    minimum: 1,
    maximum: 365,
    description: 'Días de validez de la receta (ajuste de la clínica)',
  })
  validityDays!: number;
  @ApiProperty({ example: 10, description: 'Medicamentos por receta' })
  maxItems!: number;
  @ApiProperty({
    description:
      'La receta imprime la cantidad también en letras (ajuste de la clínica)',
  })
  printQuantityInWords!: boolean;
  @ApiProperty({
    description:
      'Se exige el documento del paciente, que se imprime como nº de historia clínica (ajuste de la clínica)',
  })
  requireClinicalRecordNumber!: boolean;
  @ApiProperty({
    enum: LEGACY_PRESCRIPTION_COUNTRIES,
    enumName: 'LegacyPrescriptionCountry',
    nullable: true,
    deprecated: true,
    description:
      'Fase 1: país legado de la sede, solo para la web anterior a DX-324; la fase 2 lo retira. La web nueva no lo lee.',
  })
  country!: LegacyPrescriptionCountry | null;
}
