import { ApiProperty } from '@nestjs/swagger';
import { PostOpClinicBrandingDto } from './post-op-delivery.dto';

// Respuesta de GET /public/post-op-instructions/:token. Sin ids ni datos
// sueltos del paciente: solo el texto tal como se le entregó.
export class PublicPostOpDto {
  @ApiProperty({ type: PostOpClinicBrandingDto })
  clinic!: PostOpClinicBrandingDto;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Teléfono de la sede de la cita, para dudas',
  })
  locationPhone!: string | null;
  @ApiProperty({ description: 'Título de la plantilla al entregarla' })
  title!: string;
  @ApiProperty({ example: 'POI-EXO' }) code!: string;
  @ApiProperty({ description: 'Versión de la plantilla de la que salió' })
  version!: number;
  @ApiProperty({ description: 'Texto tal como se entregó' })
  renderedText!: string;
  @ApiProperty({ type: String, format: 'date-time' }) deliveredAt!: Date;
}
