import { ApiProperty } from '@nestjs/swagger';

// Respuesta de /consent-templates: documenta la entidad ConsentTemplate para
// Swagger (y para el cliente web generado); no valida entrada.
export class ConsentTemplateDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({
    description:
      'Texto con variables {{paciente}}, {{documento}}, {{profesional}}, {{clinica}}, {{fecha}} y {{tratamiento}}.',
  })
  body!: string;

  @ApiProperty()
  active!: boolean;

  @ApiProperty({
    description:
      'Sube en 1 con cada cambio de título o texto. El consentimiento firmado guarda la versión de la que salió.',
  })
  version!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}
