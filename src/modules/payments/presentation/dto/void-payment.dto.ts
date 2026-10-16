import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

// Cuerpo de DELETE /payments/:id (SEC-013). Solo el motivo: quién anula sale
// del token (req.user.sub) y cuándo, del reloj del servidor — nunca del cliente.
export class VoidPaymentDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 300,
    example: 'Cobro duplicado: el paciente pagó una sola vez',
    description:
      'Motivo de la anulación (3–300 caracteres tras quitar espacios). Queda ' +
      'guardado junto a quién y cuándo anuló.',
  })
  @Transform(trim)
  @IsString()
  @Length(3, 300)
  reason!: string;
}
