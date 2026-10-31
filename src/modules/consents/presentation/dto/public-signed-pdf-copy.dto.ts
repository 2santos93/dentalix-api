import { ApiProperty } from '@nestjs/swagger';

export class PublicSignedPdfCopyClinicDto {
  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  primaryColor!: string | null;

  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;
}

/** DX-443: lo que ve quien abre el enlace de la copia. Nada clínico. */
export class PublicSignedPdfCopyDto {
  @ApiProperty({
    enum: ['AVAILABLE', 'USED'],
    enumName: 'PublicSignedPdfCopyState',
    description:
      '`AVAILABLE`: se puede descargar una vez. `USED`: el enlace ya se usó. Caducado, invalidado (al reenviar), inventado o de otra clínica: 404.',
  })
  state!: 'AVAILABLE' | 'USED';

  @ApiProperty({
    example: 'Tu copia del documento firmado está lista para descargar',
  })
  message!: string;

  @ApiProperty({ type: PublicSignedPdfCopyClinicDto, nullable: true })
  clinic!: PublicSignedPdfCopyClinicDto | null;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: Date;
}

/** DX-443: la descarga (el enlace ya quedó usado). */
export class SignedPdfCopyDownloadDto {
  @ApiProperty({
    description:
      'URL firmada de 60 s del PDF archivado, como attachment (ábrela de inmediato).',
  })
  url!: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: Date;

  @ApiProperty({
    example: 'Consentimiento firmado - Exodoncia - 2026-10-31.pdf',
  })
  fileName!: string;
}
