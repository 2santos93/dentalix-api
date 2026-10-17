import {
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import {
  JobsAdmin,
  type JobsStats,
} from '../../jobs/application/jobs-admin.service';
import type { FailedJob } from '../../jobs/domain/job';
import type { PlatformJwtPayload } from '../../../shared/crypto/token.service';
import { currentRequestId } from '../../../shared/observability/request-context';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import {
  FAILED_JOBS_DEFAULT_LIMIT,
  FailedJobDto,
  ListFailedJobsQueryDto,
} from './dto/failed-job.dto';
import { JobsStatsDto, RetriedJobDto } from './dto/jobs-stats.dto';

interface PlatformRequest {
  user: PlatformJwtPayload;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Operación de la cola de trabajos en segundo plano (DX-085, DX-220). Ruta de
 * PLATAFORMA como /platform/tenants: solo token de plataforma de un
 * superadmin vigente, sin tenant. Nunca devuelve payloads salvo la cola de
 * fallidos (ids técnicos), que es para diagnosticar.
 */
@ApiTags('platform')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@ApiUnauthorizedResponse({ description: 'Sin sesión' })
@ApiForbiddenResponse({
  description: 'No es un token de plataforma de un superadmin',
})
@Controller('platform/jobs')
export class PlatformJobsController {
  constructor(private readonly jobs: JobsAdmin) {}

  @Get('failed')
  @ApiOperation({
    summary: 'Cola de fallidos: trabajos que agotaron sus intentos',
    description:
      'Los más recientes primero. Cada trabajo se reintenta con backoff exponencial hasta su maxAttempts y luego queda FAILED. Solo superadmin de plataforma.',
  })
  @ApiOkResponse({ type: [FailedJobDto] })
  failed(@Query() query: ListFailedJobsQueryDto): Promise<FailedJob[]> {
    return this.jobs.listFailed(query.limit ?? FAILED_JOBS_DEFAULT_LIMIT);
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Estado de la cola: profundidad, retraso, workers vivos y tareas',
    description:
      'PENDING vencidos y su retraso (ahora − min(runAt)), RUNNING, FAILED en 24 h, workers con latido de menos de 60 s y, por tarea programada, lastRunAt/nextRunAt y si va con retraso (más de 2 periodos). Solo contadores, ids y fechas. Solo superadmin de plataforma.',
  })
  @ApiOkResponse({ type: JobsStatsDto })
  stats(): Promise<JobsStats> {
    return this.jobs.stats();
  }

  @Post(':id/retry')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reencola un trabajo FAILED (attempts = 0, ya)',
    description:
      'Una sola vez: si ya no está FAILED (otro reintento lo reencoló) da 409. Conserva su idempotencyKey, así que no crea un trabajo duplicado. Queda en platform_audit_events (JOB_RETRIED) sin el payload. Solo superadmin de plataforma.',
  })
  @ApiOkResponse({ type: RetriedJobDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({ description: 'No existe (o ya se purgó)' })
  @ApiConflictResponse({
    description: 'No está FAILED: ya se reencoló o nunca falló',
  })
  async retry(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: PlatformRequest,
  ): Promise<RetriedJobDto> {
    const userAgent = req.headers['user-agent'];
    const result = await this.jobs.retry(id, {
      userId: req.user.sub,
      requestId: currentRequestId() ?? null,
      ip: req.ip ?? null,
      userAgent: (Array.isArray(userAgent) ? userAgent[0] : userAgent) ?? null,
    });
    if (result.status === 'not_found') {
      throw new NotFoundException('Trabajo no encontrado');
    }
    if (result.status === 'not_failed') {
      throw new ConflictException(
        `El trabajo no está FAILED (está ${result.state}): ya se reencoló o nunca falló`,
      );
    }
    return {
      id: result.job.id,
      name: result.job.name,
      tenantId: result.job.tenantId,
      state: 'PENDING',
      attempts: 0,
      previousAttempts: result.job.previousAttempts,
    };
  }
}
