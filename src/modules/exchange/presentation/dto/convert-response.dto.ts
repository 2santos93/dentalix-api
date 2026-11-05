import { ApiProperty } from '@nestjs/swagger';

// Response shape for GET /exchange/convert — documents the ConvertAmountResult
// contract for Swagger (see convert-amount.use-case.ts); the use case already
// returns values shaped exactly like this.
export class ConvertResponseDto {
  @ApiProperty({ example: 100 })
  amount!: number;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  from!: string;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  to!: string;

  @ApiProperty({ example: '2026-07-01' })
  date!: string;

  @ApiProperty({
    example: '2026-06-30',
    description:
      'DX-384: día civil de la tasa usada. Es `date` salvo con tasa manual cuando la clínica no registró la de ese día y se usó la última dentro de su plazo.',
  })
  rateDate!: string;

  @ApiProperty({ example: 400000 })
  result!: number;

  @ApiProperty({
    example: 4000,
    description: 'Effective from→to rate actually applied.',
  })
  rateUsed!: number;
}
