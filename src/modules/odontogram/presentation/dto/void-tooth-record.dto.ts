import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { VOID_REASON_MAX } from '../../application/use-cases/void-tooth-record.use-case';

// Solo el motivo: autor (JWT), fecha (BD), paciente y registro (ruta).
export class VoidToothRecordDto {
  @ApiProperty({
    minLength: 1,
    maxLength: VOID_REASON_MAX,
    example: 'Registrado en el diente equivocado',
  })
  @IsString({ message: 'El motivo de la anulación es obligatorio' })
  @IsNotEmpty({ message: 'El motivo de la anulación es obligatorio' })
  @MaxLength(VOID_REASON_MAX, {
    message: `El motivo admite como mucho ${VOID_REASON_MAX} caracteres`,
  })
  reason!: string;
}
