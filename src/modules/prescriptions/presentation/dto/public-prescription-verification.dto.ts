import { ApiProperty } from '@nestjs/swagger';
import { PrescriptionLocationFormatDto } from './prescription.dto';

/**
 * Respuesta de GET /public/prescription-verifications/:code (DX-467). Siempre
 * la misma forma; cada estado rellena solo lo suyo. Nunca medicamentos,
 * diagnóstico, documento ni nombre del paciente, motivo de la anulación ni
 * ids.
 */
export class PublicPrescriptionVerificationDto {
  @ApiProperty({
    enum: ['VALID', 'VOIDED', 'UNVERIFIABLE'],
    enumName: 'PublicPrescriptionVerificationState',
    description:
      'VALID = auténtica y no anulada; VOIDED = anulada; UNVERIFIABLE = el hash guardado no coincide con el recalculado (no se puede verificar: contactar con la clínica).',
  })
  state!: 'VALID' | 'VOIDED' | 'UNVERIFIABLE';
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Emisión (solo VALID).',
  })
  issuedAt!: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Anulación (solo VOIDED; sin motivo ni autor).',
  })
  voidedAt!: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Profesional que la emitió (solo VALID).',
  })
  professionalName!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Su nº de registro profesional (solo VALID).',
  })
  professionalLicense!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Clínica tal como figura en la receta (solo VALID).',
  })
  clinicName!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'A. P. G.',
    description: 'Iniciales del paciente (solo VALID).',
  })
  patientInitials!: string | null;
  @ApiProperty({
    type: PrescriptionLocationFormatDto,
    nullable: true,
    description:
      'Formato regional y zona actuales de la sede de la receta, para pintar la fecha como en la receta impresa. Solo con fecha que pintar (VALID y VOIDED); null en UNVERIFIABLE.',
  })
  regional!: PrescriptionLocationFormatDto | null;
}
