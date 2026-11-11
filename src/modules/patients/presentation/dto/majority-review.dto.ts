import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResponsibleRelationship } from '@prisma/client';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  MAJORITY_REVIEW_DECISIONS,
  MAJORITY_REVIEW_NOTE_MAX,
  type MajorityReviewDecision,
  type MajorityReviewStatus,
} from '../../domain/responsible-parties/majority-review';
import { COMING_OF_AGE_MAX_DAYS } from '../../application/use-cases/majority-review.use-cases';

const STATUSES: MajorityReviewStatus[] = [
  'NOT_APPLICABLE',
  'PENDING',
  'REVIEWED',
];

const STATUS_DESCRIPTION =
  'NOT_APPLICABLE: menor, sin fecha de nacimiento o sin responsable dado de alta antes de su mayoría de edad. ' +
  'PENDING: cumplió la mayoría de edad con responsable y no está revisado para su fecha de mayoría de edad vigente ' +
  '(mientras tanto avisos, recibos y estados de cuenta van a su propio email o a nadie). ' +
  'REVIEWED: revisado; rige `decision`.';

const DECISION_DESCRIPTION =
  'PATIENT_SELF: los envíos van al propio paciente (sin email: a nadie). ' +
  'KEEP_RESPONSIBLE: el paciente consiente que sigan yendo a su responsable (regla general DX-203).';

/** `POST /patients/:id/majority-review`. */
export class ReviewMajorityDto {
  @ApiProperty({
    enum: MAJORITY_REVIEW_DECISIONS,
    enumName: 'MajorityReviewDecision',
    description: DECISION_DESCRIPTION,
  })
  @IsIn(MAJORITY_REVIEW_DECISIONS, {
    message: 'decision tiene que ser PATIENT_SELF o KEEP_RESPONSIBLE.',
  })
  decision!: MajorityReviewDecision;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: MAJORITY_REVIEW_NOTE_MAX,
    description:
      'Nota libre (p. ej. con quién se habló). Se guarda con la revisión; nunca va a la auditoría.',
  })
  @IsOptional()
  @IsString({ message: 'La nota tiene que ser texto.' })
  @MaxLength(MAJORITY_REVIEW_NOTE_MAX, {
    message: `La nota no puede pasar de ${MAJORITY_REVIEW_NOTE_MAX} caracteres.`,
  })
  note?: string | null;
}

export class MajorityReviewResponsibleDto {
  @ApiProperty({ format: 'uuid', description: 'Id del vínculo' })
  id!: string;

  @ApiProperty({ example: 'Carmen Rondón' })
  name!: string;

  @ApiProperty({
    enum: ResponsibleRelationship,
    enumName: 'ResponsibleRelationship',
  })
  relationship!: ResponsibleRelationship;

  @ApiProperty()
  receivesNotices!: boolean;

  @ApiProperty()
  isPayer!: boolean;
}

/** Aviso y modal «Paso a la mayoría de edad» de la ficha (DX-342). */
export class MajorityReviewViewDto {
  @ApiProperty({
    enum: STATUSES,
    enumName: 'MajorityReviewStatus',
    description: STATUS_DESCRIPTION,
  })
  status!: MajorityReviewStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date',
    example: '2026-11-20',
    description:
      'Día en que cumple la mayoría de edad de la clínica (el 29/2 cae el 1/3 de un año no bisiesto); null sin fecha de nacimiento.',
  })
  majorityDate!: string | null;

  @ApiProperty({
    enum: MAJORITY_REVIEW_DECISIONS,
    enumName: 'MajorityReviewDecision',
    nullable: true,
    description: `Solo con REVIEWED. ${DECISION_DESCRIPTION}`,
  })
  decision!: MajorityReviewDecision | null;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'Solo con REVIEWED.',
  })
  reviewedAt!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Quién lo revisó (solo con REVIEWED); null si ya no es de la clínica.',
  })
  reviewedByName!: string | null;

  @ApiProperty({
    type: [MajorityReviewResponsibleDto],
    description: 'Responsables vivos, en orden de alta.',
  })
  responsibles!: MajorityReviewResponsibleDto[];
}

/** `GET /patients/coming-of-age`. */
export class ComingOfAgeQueryDto {
  @ApiProperty({
    example: '2026-11-01',
    description: 'Primer día (AAAA-MM-DD), inclusive.',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'from debe ser una fecha AAAA-MM-DD.',
  })
  from!: string;

  @ApiProperty({
    example: '2026-11-30',
    description: `Último día (AAAA-MM-DD), inclusive; >= from y como mucho ${COMING_OF_AGE_MAX_DAYS} días (400 si no).`,
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'to debe ser una fecha AAAA-MM-DD.',
  })
  to!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo los pacientes de esta sede (la de su última cita atendida). 404 si no es una sede de la clínica; 403 LOCATION_NOT_ALLOWED si no está entre las permitidas al miembro.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;
}

export class ComingOfAgeItemDto {
  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ example: 'Sofía Rondón' })
  fullName!: string;

  @ApiProperty({ example: '1042' })
  patientCode!: string;

  @ApiProperty({ format: 'date', example: '2008-11-20' })
  birthDate!: string;

  @ApiProperty({ format: 'date', example: '2026-11-20' })
  majorityDate!: string;

  @ApiProperty({
    example: 18,
    description: 'Mayoría de edad de la clínica.',
  })
  majorityAge!: number;

  @ApiProperty({
    enum: STATUSES,
    enumName: 'MajorityReviewStatus',
    description: STATUS_DESCRIPTION,
  })
  status!: MajorityReviewStatus;

  @ApiProperty({
    description:
      'Ya adulto y PENDING con la mayoría de edad antes de `from` (atrasado).',
  })
  overdue!: boolean;

  @ApiProperty({ description: 'Responsables vivos.' })
  responsiblesCount!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description:
      'Sede del paciente: la de su última cita atendida; null sin ninguna.',
  })
  locationId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  locationName!: string | null;
}

/** Lista «Pasan a la mayoría de edad» (DX-342). */
export class ComingOfAgeListDto {
  @ApiProperty({ format: 'date' })
  from!: string;

  @ApiProperty({ format: 'date' })
  to!: string;

  @ApiProperty({ example: 18 })
  majorityAge!: number;

  @ApiProperty({
    description:
      'El miembro está restringido a unas sedes (DX-525): solo ve a los pacientes de esas sedes.',
  })
  restrictedToLocations!: boolean;

  @ApiProperty({
    type: [ComingOfAgeItemDto],
    description:
      'Primero los atrasados (`overdue`), luego por fecha de mayoría de edad y nombre.',
  })
  items!: ComingOfAgeItemDto[];
}
