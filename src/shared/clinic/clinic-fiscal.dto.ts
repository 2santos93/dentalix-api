import { ApiProperty } from '@nestjs/swagger';

const NULLABLE = { type: String, nullable: true } as const;

/** DX-019: datos fiscales y de contacto de la clínica en un documento imprimible. */
export class ClinicFiscalDto {
  @ApiProperty(NULLABLE)
  legalName!: string | null;

  @ApiProperty({
    ...NULLABLE,
    description: 'Null = el nombre genérico («Id. fiscal»).',
  })
  taxIdLabel!: string | null;

  @ApiProperty({
    ...NULLABLE,
    description: 'Texto libre, sin formato de ningún país.',
  })
  taxId!: string | null;

  @ApiProperty(NULLABLE)
  address!: string | null;

  @ApiProperty(NULLABLE)
  email!: string | null;

  @ApiProperty(NULLABLE)
  phone!: string | null;
}
