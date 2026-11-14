import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString } from 'class-validator';
import { MAX_PAYMENT_PROOF_BYTES } from '../../domain/payment-proof';

export class CreatePaymentProofUploadDto {
  @ApiPropertyOptional({ example: 'captura-pago-movil.png' })
  @IsOptional()
  @IsString({ message: 'El nombre del archivo debe ser un texto.' })
  name?: string;

  @ApiPropertyOptional({ example: 'image/png' })
  @IsOptional()
  @IsString({ message: 'El tipo del archivo debe ser un texto.' })
  mimeType?: string;

  @ApiProperty({
    minimum: 1,
    maximum: MAX_PAYMENT_PROOF_BYTES,
    description: 'Tamaño en bytes (1 B – 10 MB)',
  })
  @IsInt({ message: 'El tamaño del comprobante no es válido.' })
  size!: number;

  @ApiProperty({
    pattern: '^[0-9a-f]{64}$',
    description:
      'SHA-256 del contenido en hex. El almacén rechaza un contenido con otra huella.',
  })
  @IsString({ message: 'La huella SHA-256 del comprobante no es válida.' })
  sha256!: string;
}

export class PaymentProofTargetDto {
  @ApiProperty({ enum: ['POST'] }) method!: 'POST';
  @ApiProperty({
    description:
      'Adónde se envía el formulario: el bucket (S3) o la API (disco, en desarrollo)',
  })
  url!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'Campos del formulario, en este orden y ANTES del fichero, que va al final en el campo `file`',
  })
  fields!: Record<string, string>;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

export class PaymentProofUploadDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Se entrega al registrar el abono (`proofUploadId`), en su cuerpo.',
  })
  uploadId!: string;
  @ApiProperty({ type: PaymentProofTargetDto }) target!: PaymentProofTargetDto;
  @ApiProperty({ description: 'Tamaño máximo en bytes' }) maxBytes!: number;
}

export class PaymentProofUrlQueryDto {
  @ApiPropertyOptional({ enum: ['inline', 'attachment'], default: 'inline' })
  @IsOptional()
  @IsEnum(['inline', 'attachment'], {
    message: 'La disposición debe ser inline o attachment.',
  })
  disposition?: 'inline' | 'attachment';
}

export class PaymentProofUrlDto {
  @ApiProperty() url!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ enum: ['inline', 'attachment'] })
  disposition!: 'inline' | 'attachment';
  @ApiProperty({
    enum: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
  })
  mime!: string;
  @ApiProperty({ description: 'Nombre original, solo para mostrar.' })
  name!: string;
}
