import {
  Controller,
  Get,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import {
  ListSupportAccessesUseCase,
  type SupportAccessesPage,
} from '../application/list-support-accesses.use-case';
import {
  ListSupportAccessesQueryDto,
  SupportAccessesPageDto,
} from './dto/support-access.dto';

/**
 * SEC-008: accesos de soporte (break-glass) de superadmins de Dentalix a esta
 * clínica. Solo ADMIN. Aislado por clínica (RLS forzada). Leerlo no deja
 * evento de auditoría (como /audit-events).
 */
@ApiTags('support-accesses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(ClinicRole.ADMIN)
@Controller('support-accesses')
export class SupportAccessesController {
  constructor(private readonly listAccesses: ListSupportAccessesUseCase) {}

  @Get()
  @ApiOperation({
    summary:
      'Accesos de soporte de Dentalix a la clínica (más reciente primero)',
    description:
      'Cada vez que un superadmin entra a la clínica sin ser miembro (con MFA y motivo) queda aquí: quién, ' +
      'motivo, IP, navegador, cuándo y hasta cuándo valía. Paginado por cursor (`nextCursor`).',
  })
  @ApiOkResponse({ type: SupportAccessesPageDto })
  @ApiBadRequestResponse({
    description: 'Cursor manipulado o limit fuera de 1–100',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  list(
    @Query() query: ListSupportAccessesQueryDto,
  ): Promise<SupportAccessesPage> {
    return this.listAccesses.execute(query);
  }
}
