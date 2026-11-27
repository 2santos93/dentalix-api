import { ApiProperty } from '@nestjs/swagger';
import { IsDefined, IsString, MaxLength, ValidateIf } from 'class-validator';

/** DX-066: notas de un examen en DRAFT. */
export class UpdatePerioNotesDto {
  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: 2000,
    example:
      'Control a los 3 meses tras el raspado. Reforzar higiene interproximal.',
    description:
      'Texto nuevo de las notas. null o vacío las borra. Solo en un examen en DRAFT (FINAL: 409).',
  })
  // null borra; ausente es un 400 (el cuerpo es solo esto).
  @ValidateIf((_, value) => value !== null)
  @IsDefined({ message: 'Faltan las notas (null para borrarlas)' })
  @IsString({ message: 'Las notas deben ser texto' })
  @MaxLength(2000, { message: 'Las notas no pueden superar 2000 caracteres' })
  notes!: string | null;
}
