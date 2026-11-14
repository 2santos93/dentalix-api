import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';
import {
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
} from '../../../../shared/time/civil-day';
import { PATIENT_LINKS_MAX_DAYS } from '../../application/use-cases/get-patient-links.use-case';
import { PATIENT_LINK_TYPES } from '../../domain/patient-links';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Filtros de GET /reports/patient-links (DX-424).
export class PatientLinksQueryDto {
  @ApiProperty({
    example: '2026-10-01',
    description: `Primer día del período de ENVÍO (AAAA-MM-DD, en la zona de la sede de cada enlace). Como mucho ${PATIENT_LINKS_MAX_DAYS} días; las dos fechas entre ${PERIOD_DAY_MIN} y ${PERIOD_DAY_MAX} (400 si no).`,
  })
  @Matches(CIVIL_DATE, { message: 'from debe ser una fecha AAAA-MM-DD.' })
  from!: string;

  @ApiProperty({ example: '2026-10-31', description: 'Último día (inclusive)' })
  @Matches(CIVIL_DATE, { message: 'to debe ser una fecha AAAA-MM-DD.' })
  to!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo esta sede (403 si no es de las del usuario o no es de la clínica: la misma respuesta, sin decir qué sedes existen). Sin él, todas las sedes que ve. La cabecera X-Location-Id no acota.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;
}

export class PatientLinkMetricsDto {
  @ApiProperty({
    enum: PATIENT_LINK_TYPES,
    enumName: 'PatientLinkType',
    description:
      'ANAMNESIS = cuestionario de salud por enlace; CONSENT_SIGNATURE = firma a distancia de un consentimiento; BUDGET_SIGNATURE = aceptación a distancia de un presupuesto; APPOINTMENT_CONFIRMATION = confirmar, cancelar o «llámenme» de una cita; POST_OP_INSTRUCTIONS = indicaciones postoperatorias por email o WhatsApp (las impresas no cuentan).',
  })
  linkType!: (typeof PATIENT_LINK_TYPES)[number];

  @ApiProperty({
    description:
      'El tipo registra la apertura. false (confirmación de cita): opened, expiredUnopened y sus tasas van en null.',
  })
  tracksOpened!: boolean;

  @ApiProperty({
    description:
      'El tipo tiene un paso de completar. false (indicaciones postoperatorias: abrirlas es todo el uso): completed, su tasa y la mediana van en null.',
  })
  tracksCompleted!: boolean;

  @ApiProperty({
    example: 40,
    description: 'Enlaces enviados en el período (por fecha de envío)',
  })
  sent!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 28,
    description:
      'De los enviados, los abiertos alguna vez (completar cuenta como abrir). null si el tipo no registra la apertura.',
  })
  opened!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 22,
    description:
      'De los enviados, los completados (anamnesis enviada, documento firmado, cita respondida). null si el tipo no tiene ese paso.',
  })
  completed!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 6,
    description:
      'De los enviados, los que caducaron sin abrirse ni completarse. Un enlace anulado o reemplazado NO cuenta. null si el tipo no registra la apertura.',
  })
  expiredUnopened!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 70,
    description:
      'Abiertos ÷ enviados en %, con 1 decimal (70 = 70 %). null sin envíos o sin señal.',
  })
  openedRate!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 55,
    description:
      'Completados ÷ enviados en %, con 1 decimal. null sin envíos o sin señal.',
  })
  completedRate!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 15,
    description:
      'Caducados sin abrir ÷ enviados en %, con 1 decimal. null sin envíos o sin señal.',
  })
  expiredUnopenedRate!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 5.5,
    description:
      'Mediana de horas del envío al completado, con 1 decimal. null sin completados o sin ese paso.',
  })
  medianHoursToComplete!: number | null;
}

export class LocationPatientLinksDto {
  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({ example: 'Sede Chacao' })
  locationName!: string;

  @ApiProperty({ example: 'America/Caracas' })
  timeZone!: string;

  @ApiProperty({
    type: [PatientLinkMetricsDto],
    description: 'Un tipo por fila, siempre los cinco y en el mismo orden',
  })
  rows!: PatientLinkMetricsDto[];
}

export class PatientLinksReportDto {
  @ApiProperty({ example: '2026-10-01' })
  from!: string;

  @ApiProperty({ example: '2026-10-31' })
  to!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;

  @ApiProperty({
    description:
      'El usuario solo ve algunas sedes (DX-089): los totales son de ellas',
  })
  restrictedToLocations!: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Instante con el que se decidió qué enlaces ya caducaron',
  })
  asOf!: Date;

  @ApiProperty({
    type: [PatientLinkMetricsDto],
    description:
      'Todas las sedes visibles juntas (la mediana, de todos los enlaces), un tipo por fila',
  })
  totals!: PatientLinkMetricsDto[];

  @ApiProperty({
    type: [LocationPatientLinksDto],
    description:
      'Una entrada por sede visible (con zona horaria), por fecha de alta',
  })
  locations!: LocationPatientLinksDto[];
}
