import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  PRESCRIPTION_COPY_FOOTER_MESSAGE,
  PRESCRIPTION_VALIDITY_DAYS_MAX,
  PRESCRIPTION_VALIDITY_DAYS_MESSAGE,
  PRESCRIPTION_VALIDITY_DAYS_MIN,
} from '../../domain/prescription-settings';

/** Ajustes de la receta de la clínica (DX-324): iguales en todas sus sedes. */
export class PrescriptionSettingsDto {
  @ApiProperty({
    example: true,
    description:
      'La receta imprime la cantidad total de cada medicamento también en letras.',
  })
  @IsBoolean({ message: 'Indica sí o no en «cantidad en letras».' })
  printQuantityInWords!: boolean;

  @ApiProperty({
    example: false,
    description:
      'Emitir exige el documento del paciente, que la receta imprime como nº de historia clínica.',
  })
  @IsBoolean({
    message: 'Indica sí o no en «exigir el nº de historia clínica».',
  })
  requireClinicalRecordNumber!: boolean;

  @ApiProperty({
    minimum: PRESCRIPTION_VALIDITY_DAYS_MIN,
    maximum: PRESCRIPTION_VALIDITY_DAYS_MAX,
    example: 30,
    description:
      'Días civiles de validez de la receta, contando el de la fecha de inicio.',
  })
  @IsInt({ message: PRESCRIPTION_VALIDITY_DAYS_MESSAGE })
  @Min(PRESCRIPTION_VALIDITY_DAYS_MIN, {
    message: PRESCRIPTION_VALIDITY_DAYS_MESSAGE,
  })
  @Max(PRESCRIPTION_VALIDITY_DAYS_MAX, {
    message: PRESCRIPTION_VALIDITY_DAYS_MESSAGE,
  })
  validityDays!: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 300,
    example:
      'Copia para el paciente. Para retirar el medicamento presente la receta impresa y firmada.',
    description:
      'DX-468: pie de la copia de la receta que se envía al paciente. null o vacío = el de plataforma. Ausente en el PUT = no cambia.',
  })
  @IsOptional()
  @IsString({ message: PRESCRIPTION_COPY_FOOTER_MESSAGE })
  // Antes de recortar: un texto enorme se rechaza sin procesarlo.
  @MaxLength(2000, { message: PRESCRIPTION_COPY_FOOTER_MESSAGE })
  patientCopyFooter?: string | null;
}
