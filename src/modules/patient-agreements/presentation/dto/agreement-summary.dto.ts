import { ApiProperty } from '@nestjs/swagger';
import type { AgreementSummary } from '../../application/patient-agreement-flags';

/**
 * Resumen del convenio vigente de un paciente (DX-105), para la ficha.
 * Evaluado a hoy (día civil de la sede).
 */
export class AgreementSummaryDto implements AgreementSummary {
  @ApiProperty({
    enum: ['NONE', 'ACTIVE', 'EXPIRED', 'NOT_STARTED', 'INACTIVE'],
    enumName: 'AgreementSummaryStatus',
    description:
      'NONE: sin convenio asignado. INACTIVE: el convenio está desactivado. EXPIRED / NOT_STARTED: la vigencia del convenio o de la asignación terminó o no empezó. ACTIVE: el resto.',
  })
  status!: AgreementSummary['status'];

  @ApiProperty({ type: String, nullable: true })
  agreementName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  payerName!: string | null;
}
