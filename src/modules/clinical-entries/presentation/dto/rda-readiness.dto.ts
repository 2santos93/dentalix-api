import { ApiProperty } from '@nestjs/swagger';

const MISSING_CODES = [
  'PATIENT_DOCUMENT',
  'PRINCIPAL_DIAGNOSIS',
  'PROCEDURE_CUPS',
  'AUTHOR_LICENSE',
] as const;

export class RdaMissingItemDto {
  @ApiProperty({ enum: MISSING_CODES, enumName: 'RdaMissingCode' })
  code!: (typeof MISSING_CODES)[number];

  @ApiProperty({ example: 'Código CUPS de «Profilaxis»' })
  label!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Dónde completarlo: paciente (PATIENT_DOCUMENT), ítem del catálogo (PROCEDURE_CUPS) o usuario autor (AUTHOR_LICENSE); null si no aplica.',
  })
  resourceId!: string | null;
}

export class RdaPendingItemDto {
  @ApiProperty({ enum: ['CLINIC_TAX_ID'], enumName: 'RdaPendingCode' })
  code!: 'CLINIC_TAX_ID';

  @ApiProperty({ example: 'NIT de la clínica' })
  label!: string;

  @ApiProperty({ example: 'pendiente de DX-019' })
  reason!: string;
}

export class RdaReadinessDto {
  @ApiProperty({
    description:
      'true en una sede fuera de Colombia: el RDA no aplica (ready=false, listas vacías).',
  })
  notApplicable!: boolean;

  @ApiProperty({ description: 'Sin faltantes (los pendientes no cuentan).' })
  ready!: boolean;

  @ApiProperty({ type: [RdaMissingItemDto] })
  missing!: RdaMissingItemDto[];

  @ApiProperty({
    type: [RdaPendingItemDto],
    description: 'Datos que aún no existen en Dentalix y no bloquean.',
  })
  pending!: RdaPendingItemDto[];
}
