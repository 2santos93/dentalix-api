import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { JobsAdmin } from '../../jobs/application/jobs-admin.service';
import type { FailedJob } from '../../jobs/domain/job';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import {
  FAILED_JOBS_DEFAULT_LIMIT,
  FailedJobDto,
  ListFailedJobsQueryDto,
} from './dto/failed-job.dto';

/**
 * Operación de la cola de trabajos en segundo plano (DX-085). Ruta de
 * PLATAFORMA como /platform/tenants: solo token de plataforma de un
 * superadmin vigente, sin tenant.
 */
@ApiTags('platform')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
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
  @ApiUnauthorizedResponse({ description: 'Sin sesión' })
  @ApiForbiddenResponse({
    description: 'No es un token de plataforma de un superadmin',
  })
  failed(@Query() query: ListFailedJobsQueryDto): Promise<FailedJob[]> {
    return this.jobs.listFailed(query.limit ?? FAILED_JOBS_DEFAULT_LIMIT);
  }
}
