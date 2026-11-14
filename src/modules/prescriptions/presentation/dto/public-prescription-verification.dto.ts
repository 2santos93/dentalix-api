import { ApiProperty } from '@nestjs/swagger';

/**
 * DX-467: lo que la página pública `/receta/<código>` sabe de una receta. Lo
 * mínimo: ni medicamentos, ni diagnóstico, ni documento del paciente, ni el
 * motivo de la anulación. Los campos que no tocan al estado van a `null`.
 */
export class PublicPrescriptionVerificationDto {
  @ApiProperty({
    enum: ['VALID', 'VOIDED', 'UNVERIFIABLE'],
    enumName: 'PublicPrescriptionVerificationStatus',
    description:
      '`VALID`: «Receta válida» con día de emisión, profesional, registro, clínica e iniciales. `VOIDED`: «Receta anulada el …», solo con el día. `UNVERIFIABLE`: el hash guardado no casa con el contenido («No se puede verificar; contacte con la clínica»), sin ningún otro dato. Código mal formado, inexistente o de otra clínica: 404.',
  })
  status!: 'VALID' | 'VOIDED' | 'UNVERIFIABLE';

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: '2026-11-14',
    description:
      'Solo `VALID`: día civil de la emisión en la zona de la sede (null si la sede no tiene zona válida).',
  })
  issuedOn!: string | null;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: '2026-11-19',
    description:
      'Solo `VOIDED`: día civil de la anulación en la zona de la sede (null si la sede no tiene zona válida).',
  })
  voidedOn!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Dra. Andreína Salazar',
  })
  professionalName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'MPPS 45678',
    description: 'Registro profesional congelado en la receta',
  })
  professionalLicense!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Clínica Dental Los Palos Grandes',
  })
  clinicName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'M. J. P. R.' })
  patientInitials!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'es-VE',
    description:
      'Locale de la sede, para escribir las fechas con su formato (null = sin formato: la web pinta «—»).',
  })
  locale!: string | null;

  @ApiProperty({
    enum: ['h12', 'h23'],
    enumName: 'PrescriptionHourCycle',
    nullable: true,
    example: 'h12',
    description:
      'Reloj de la sede (lo pide el formateador regional de la web junto al locale).',
  })
  hourCycle!: 'h12' | 'h23' | null;
}
