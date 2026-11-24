import { ApiProperty } from '@nestjs/swagger';
import {
  DOWNLOAD_WINDOW_HOURS,
  SIGNED_URL_TTL_SECONDS,
  type ClinicExportState,
} from '../../domain/clinic-export';

const STATES: ClinicExportState[] = [
  'PENDING',
  'RUNNING',
  'READY',
  'DOWNLOADED',
  'EXPIRED',
  'FAILED',
];

/** DX-053: una exportación del historial de Ajustes › Exportar datos. */
export class ClinicExportDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    enum: STATES,
    enumName: 'ClinicExportState',
    description: `PENDING en cola · RUNNING generándose · READY lista (descargable una vez durante ${DOWNLOAD_WINDOW_HOURS} h) · DOWNLOADED ya descargada · EXPIRED caducada o fichero borrado · FAILED falló.`,
  })
  state!: ClinicExportState;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Quién la pidió (null si ya no es miembro de la clínica).',
  })
  requestedByName!: string | null;

  @ApiProperty({ format: 'date-time' })
  requestedAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt!: Date | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Tamaño del ZIP en bytes.',
  })
  sizeBytes!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Ficheros del ZIP (CSV y LEEME).',
  })
  fileCount!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Filas exportadas entre todos los CSV.',
  })
  totalRows!: number | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Hasta cuándo se puede descargar.',
  })
  downloadExpiresAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  downloadedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  downloadedByName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Por qué falló: BUILD_FAILED, TOO_LARGE, STALE (se quedó colgada) o LEASE_EXPIRED.',
  })
  errorCode!: string | null;

  @ApiProperty({ description: 'true solo en READY.' })
  canDownload!: boolean;
}

/** DX-053: la descarga de un solo uso. */
export class ClinicExportDownloadDto {
  @ApiProperty({
    description: `URL firmada del almacén; vale ${SIGNED_URL_TTL_SECONDS} s y descarga el ZIP como adjunto.`,
  })
  url!: string;

  @ApiProperty({ example: SIGNED_URL_TTL_SECONDS })
  expiresInSeconds!: number;

  @ApiProperty({ example: 'exportacion-dentalix-2026-11-21.zip' })
  fileName!: string;

  @ApiProperty()
  sizeBytes!: number;
}
