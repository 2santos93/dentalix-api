import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AuditableRequest } from '../../audit/presentation/audit-request-context';
import { UserSessionsService } from '../application/user-sessions.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './guards/roles.decorator';
import { sessionActor } from './session-actor';
import { SessionsClosedDto, UserSessionDto } from './dto/user-sessions.dto';

/**
 * DX-137: las sesiones de OTRO miembro de la clínica. Solo ADMIN, con sesión
 * propia. El miembro y sus sesiones se leen bajo la RLS de la clínica: las de
 * otra clínica no existen aquí (404), aunque la persona sea la misma. Cerrar
 * queda en la auditoría (SESSION, DELETE).
 */
@ApiTags('staff')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(ClinicRole.ADMIN)
@Controller('staff/:userId/sessions')
export class StaffSessionsController {
  constructor(
    private readonly sessions: UserSessionsService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Sesiones abiertas de un miembro en esta clínica' })
  @ApiOkResponse({ type: [UserSessionDto] })
  @ApiForbiddenResponse({ description: 'La sesión es un acceso de soporte' })
  @ApiNotFoundResponse({ description: 'No es miembro activo de esta clínica' })
  list(
    @Req() req: AuditableRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<UserSessionDto[]> {
    return this.sessions.listForMember(
      sessionActor(req, this.tenantContext),
      userId,
    );
  }

  @Delete(':sessionId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Cierra una sesión de un miembro',
    description:
      'El dispositivo pierde la sesión en su próxima renovación (como mucho, lo que dura un access token). Queda auditado (`SESSION_REVOKED_BY_ADMIN`).',
  })
  @ApiNoContentResponse({ description: 'Cerrada' })
  @ApiForbiddenResponse({ description: 'La sesión es un acceso de soporte' })
  @ApiNotFoundResponse({
    description:
      'No es miembro activo de esta clínica, o la sesión no es suya aquí',
  })
  async revoke(
    @Req() req: AuditableRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ): Promise<void> {
    await this.sessions.revokeForMember(
      sessionActor(req, this.tenantContext),
      userId,
      sessionId,
    );
  }

  @Post('revoke-all')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cierra todas las sesiones de un miembro en esta clínica',
    description:
      'Nunca la sesión con la que se pide. Queda auditado (`MEMBER_SESSIONS_REVOKED_BY_ADMIN`) con cuántas se cerraron.',
  })
  @ApiOkResponse({ type: SessionsClosedDto })
  @ApiForbiddenResponse({ description: 'La sesión es un acceso de soporte' })
  @ApiNotFoundResponse({ description: 'No es miembro activo de esta clínica' })
  async revokeAll(
    @Req() req: AuditableRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<SessionsClosedDto> {
    return {
      sessionsClosed: await this.sessions.revokeAllForMember(
        sessionActor(req, this.tenantContext),
        userId,
      ),
    };
  }
}
