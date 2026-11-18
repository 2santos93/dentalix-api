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
import { UserSessionsService } from '../../auth/application/user-sessions.service';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { sessionActor } from '../../auth/presentation/session-actor';
import {
  SessionsClosedDto,
  UserSessionDto,
} from '../../auth/presentation/dto/user-sessions.dto';

/**
 * DX-137: «Mi perfil › Sesiones». Las sesiones de quien pide EN ESTA clínica
 * (la cookie de sesión es de cada clínica), con la actual marcada. Cerrar una
 * (también la actual) o todas las demás queda en la auditoría (SESSION,
 * DELETE). Para cerrarlas en TODAS las clínicas: cambiar la contraseña.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
// Todos los roles: cada miembro gestiona sus propias sesiones.
@Roles(
  ClinicRole.ADMIN,
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.RECEPTION,
)
@Controller('me/sessions')
export class MySessionsController {
  constructor(
    private readonly sessions: UserSessionsService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Tus sesiones abiertas en esta clínica' })
  @ApiOkResponse({ type: [UserSessionDto] })
  @ApiForbiddenResponse({ description: 'La sesión es un acceso de soporte' })
  list(@Req() req: AuditableRequest): Promise<UserSessionDto[]> {
    const actor = sessionActor(req, this.tenantContext);
    return this.sessions.list(
      actor.tenantId,
      actor.actor.userId,
      actor.currentSessionId,
    );
  }

  @Delete(':sessionId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Cierra una de tus sesiones',
    description:
      'El dispositivo pierde la sesión en su próxima renovación (como mucho, lo que dura un access token). Cerrar la actual equivale a salir. Queda auditado (`SESSION_REVOKED_BY_SELF`).',
  })
  @ApiNoContentResponse({ description: 'Cerrada' })
  @ApiForbiddenResponse({ description: 'La sesión es un acceso de soporte' })
  @ApiNotFoundResponse({ description: 'No es una sesión tuya abierta aquí' })
  async revoke(
    @Req() req: AuditableRequest,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ): Promise<void> {
    await this.sessions.revokeOwn(
      sessionActor(req, this.tenantContext),
      sessionId,
    );
  }

  @Post('revoke-others')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cierra todas tus demás sesiones en esta clínica',
    description:
      'Todas salvo la de esta petición. Queda auditado (`OTHER_SESSIONS_REVOKED`) con cuántas se cerraron.',
  })
  @ApiOkResponse({ type: SessionsClosedDto })
  @ApiForbiddenResponse({ description: 'La sesión es un acceso de soporte' })
  async revokeOthers(@Req() req: AuditableRequest): Promise<SessionsClosedDto> {
    return {
      sessionsClosed: await this.sessions.revokeOwnOthers(
        sessionActor(req, this.tenantContext),
      ),
    };
  }
}
