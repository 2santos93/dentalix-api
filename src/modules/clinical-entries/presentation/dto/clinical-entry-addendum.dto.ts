import { ApiProperty } from '@nestjs/swagger';

// Respuesta de las adendas (DX-038). Solo documenta el contrato para Swagger:
// los casos de uso ya devuelven la entidad con esta forma.
export class ClinicalEntryAddendumDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ format: 'uuid' })
  clinicalEntryId!: string;

  @ApiProperty({ description: 'Motivo de la corrección' })
  reason!: string;

  @ApiProperty({ description: 'Texto aclaratorio' })
  text!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Autor: el usuario autenticado que la registró (servidor)',
  })
  authorId!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Fecha de registro: la fija el servidor',
  })
  createdAt!: Date;
}
