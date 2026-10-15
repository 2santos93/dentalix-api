import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

/**
 * Query de `GET /patients/:patientId/account-statement`. `from`/`to` son días
 * civiles, ambos inclusive, y acotan SOLO la lista de movimientos: los totales
 * son siempre los de toda la historia del paciente (un saldo "del período" no
 * es un saldo). El DTO comprueba la forma; que el día exista y `from <= to` lo
 * valida el caso de uso.
 */
export class AccountStatementQueryDto {
  @ApiPropertyOptional({
    example: '2026-01-01',
    description: 'Primer día de los movimientos (YYYY-MM-DD), inclusive.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must match YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-12-31',
    description:
      'Último día de los movimientos (YYYY-MM-DD), inclusive. Debe ser >= from.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must match YYYY-MM-DD' })
  to?: string;
}
