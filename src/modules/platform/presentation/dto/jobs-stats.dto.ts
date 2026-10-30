import { ApiProperty } from '@nestjs/swagger';

/** Profundidad y retraso de la cola (DX-220). Solo contadores y fechas. */
export class JobsQueueStatsDto {
  @ApiProperty({
    example: 3,
    description: 'PENDING cuya hora ya llegó: esperan a un worker',
  })
  pendingDue!: number;
  @ApiProperty({
    example: 120,
    description: 'PENDING programados para más adelante',
  })
  pendingScheduled!: number;
  @ApiProperty({
    example: 4200,
    description:
      'Retraso: ahora − min(runAt) de los PENDING vencidos, en ms (0 si no hay)',
  })
  lagMs!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  oldestDueRunAt!: Date | null;
  @ApiProperty({ example: 1 }) running!: number;
  @ApiProperty({
    example: 0,
    description: 'RUNNING con el arriendo vencido (worker caído o sin latido)',
  })
  runningExpired!: number;
  @ApiProperty({ example: 0, description: 'FAILED en las últimas 24 h' })
  failedLast24h!: number;
}

/** Un proceso worker según su latido en job_workers. */
export class JobWorkerDto {
  @ApiProperty({ example: 'worker-7d9f:1:0a1b2c3d' }) id!: string;
  @ApiProperty({ enum: ['worker', 'all'] }) role!: 'worker' | 'all';
  @ApiProperty({ type: String, nullable: true, example: 'a1b2c3d' })
  version!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) startedAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) lastBeatAt!: Date;
  @ApiProperty({ description: 'Latió hace menos de 60 s' }) alive!: boolean;
}

export class JobsWorkersStatsDto {
  @ApiProperty({
    example: 1,
    description: 'Workers con latido de menos de 60 s',
  })
  alive!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastBeatAt!: Date | null;
  @ApiProperty({
    type: [JobWorkerDto],
    description: 'Los 50 de latido más reciente (7 días de historia)',
  })
  recent!: JobWorkerDto[];
}

/** Estado de una tarea programada. */
export class JobScheduleStatusDto {
  @ApiProperty({ example: 'reminders.plan.every-5-min' }) name!: string;
  @ApiProperty({ example: '*/5 * * * *', description: 'Cron de 5 campos, UTC' })
  cron!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastRunAt!: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'null: ningún worker la ha sincronizado aún',
  })
  nextRunAt!: Date | null;
  @ApiProperty({ example: 300_000, description: 'Periodo del cron, en ms' })
  periodMs!: number;
  @ApiProperty({
    example: 0,
    description: 'ahora − nextRunAt si ya pasó, en ms',
  })
  delayMs!: number;
  @ApiProperty({
    description:
      'Con retraso: más de 2 periodos sin correr, o nunca sincronizada',
  })
  overdue!: boolean;
  @ApiProperty({
    description:
      'DX-380: una sola ejecución a la vez (no encola un tick mientras el anterior siga PENDING o RUNNING)',
  })
  singleton!: boolean;
  @ApiProperty({
    description:
      'DX-380: ticks saltados porque el anterior seguía en curso (0 si la tarea no está sincronizada)',
  })
  skippedCount!: number;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'DX-380: el último tick saltado, o null',
  })
  lastSkippedAt!: Date | null;
}

/** GET /platform/jobs/stats (DX-220). Nunca payloads ni datos de pacientes. */
export class JobsStatsDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Hora de la base a la que se tomó',
  })
  generatedAt!: Date;
  @ApiProperty({ type: JobsQueueStatsDto }) queue!: JobsQueueStatsDto;
  @ApiProperty({ type: JobsWorkersStatsDto }) workers!: JobsWorkersStatsDto;
  @ApiProperty({ type: [JobScheduleStatusDto] })
  schedules!: JobScheduleStatusDto[];
}

/** POST /platform/jobs/:id/retry. Sin el payload del trabajo. */
export class RetriedJobDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'reminders.send' }) name!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  tenantId!: string | null;
  @ApiProperty({ enum: ['PENDING'] }) state!: 'PENDING';
  @ApiProperty({ example: 0 }) attempts!: 0;
  @ApiProperty({
    example: 5,
    description: 'Intentos que llevaba al fallar',
  })
  previousAttempts!: number;
}
