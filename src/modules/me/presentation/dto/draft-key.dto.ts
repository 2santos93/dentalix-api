import { ApiProperty } from '@nestjs/swagger';

/** DX-574: clave de los borradores cifrados en el dispositivo. */
export class DraftKeyDto {
  @ApiProperty({
    description:
      'Clave AES-256-GCM en base64 (32 bytes) para cifrar en este dispositivo los borradores de evolución, anamnesis, plan y receta. Una por usuario y clínica, la misma tras volver a entrar. Se guarda solo en memoria, nunca en el dispositivo.',
    example: 'q3Jx0m3sZ1y6r2t9u8v7w6x5y4z3a2b1c0d9e8f7g6h=',
  })
  key!: string;

  @ApiProperty({
    description: 'Versión de la derivación (para rotarla sin ambigüedad).',
    example: 1,
  })
  version!: number;
}
