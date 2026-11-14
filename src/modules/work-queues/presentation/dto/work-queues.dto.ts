import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional } from 'class-validator';
import { WORK_QUEUE_KEYS, type WorkQueueKey } from '../../domain/work-queues';

export class WorkQueuesSummaryQueryDto {
  @ApiPropertyOptional({
    description:
      'Solo estas listas (separadas por comas), p. ej. el contador del menú. Acota las del rol; una lista que el rol no tiene no sale nunca.',
    enum: WORK_QUEUE_KEYS,
    enumName: 'WorkQueueKey',
    isArray: true,
    example: 'CLOSING_QUEUE,ANAMNESIS_REVIEW',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v.length > 0)
      : value,
  )
  @IsArray()
  @ArrayMaxSize(WORK_QUEUE_KEYS.length)
  @IsIn(WORK_QUEUE_KEYS, {
    each: true,
    message: `keys solo admite: ${WORK_QUEUE_KEYS.join(', ')}.`,
  })
  keys?: WorkQueueKey[];
}

export class WorkQueueOverdueDto {
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({ description: 'Lo exigible ya vencido en esa moneda' })
  amount!: number;
}

export class WorkQueueItemDto {
  @ApiProperty({ enum: WORK_QUEUE_KEYS, enumName: 'WorkQueueKey' })
  key!: WorkQueueKey;

  @ApiProperty({
    enum: ['OK', 'ERROR'],
    description:
      '`ERROR`: esa lista no se pudo contar ahora (las demás sí); el cliente avisa y reintenta',
  })
  status!: 'OK' | 'ERROR';

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'El mismo número que el `/count` (o el `total`) de la lista; `null` si `ERROR`. En RECEIVABLES, pacientes con saldo (el mayor por moneda: no se suman monedas).',
  })
  count!: number | null;

  @ApiPropertyOptional({
    type: [WorkQueueOverdueDto],
    description: 'Solo RECEIVABLES: lo vencido por moneda, sin convertir',
  })
  overdue?: WorkQueueOverdueDto[];
}

export class WorkQueuesSummaryDto {
  @ApiProperty({ format: 'date-time' })
  generatedAt!: string;

  @ApiProperty({
    type: [WorkQueueItemDto],
    description:
      'Las listas del rol en la sede activa (sin cabecera, las sedes permitidas), en el orden de la bandeja',
  })
  items!: WorkQueueItemDto[];
}
