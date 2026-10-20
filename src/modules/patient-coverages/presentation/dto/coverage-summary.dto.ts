import { ApiProperty } from '@nestjs/swagger';
import type { CoverageSummary } from '../../application/patient-coverage-flags';

/**
 * Resumen de la cobertura principal de un paciente (DX-153): lo que la ficha,
 * el listado y la agenda necesitan para avisar sin pedir el detalle. Evaluado a
 * hoy (día civil de la sede), no a la fecha de la cita. Sin número de afiliado.
 */
export class CoverageSummaryDto implements CoverageSummary {
  @ApiProperty({
    enum: ['NONE', 'ACTIVE', 'EXPIRED', 'NOT_STARTED'],
    enumName: 'CoverageSummaryStatus',
    description:
      'NONE: sin coberturas vivas. EXPIRED: la vigencia terminó antes de hoy. NOT_STARTED: empieza después de hoy. ACTIVE: el resto.',
  })
  status!: CoverageSummary['status'];

  @ApiProperty({ type: String, nullable: true })
  payerName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  planName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-12-31',
    description: 'Fin de la vigencia (AAAA-MM-DD); null si es indefinida.',
  })
  validTo!: string | null;
}
