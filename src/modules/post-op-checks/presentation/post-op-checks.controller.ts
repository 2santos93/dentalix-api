import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import {
  CLINICAL_ROLES,
  POST_OP_CHECK_LIST_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  PostOpChecksUseCases,
  type PostOpCheckCountView,
  type PostOpCheckList,
  type PostOpCheckView,
} from '../application/post-op-checks.use-cases';
import { POST_OP_MESSAGES } from '../domain/post-op-check-rules';
import {
  PostOpCheckCountDto,
  PostOpCheckDto,
  PostOpCheckListDto,
  PostOpChecksCountQueryDto,
  PostOpChecksQueryDto,
  RecordPostOpAttemptDto,
} from './dto/post-op-checks.dto';

interface AuthenticatedRequest extends AuditableRequest {
  user: TenantJwtPayload;
}

const SCOPE =
  'Controles postoperatorios PENDIENTES cuyo día de llamada ya llegó en la zona de su sede (por defecto hoy y los vencidos), de pacientes no archivados, ' +
  'primero los más vencidos y luego por hora de la cita. Solo las sedes permitidas al usuario (DX-089).';
const LOCATION_FORBIDDEN = 'Sede fuera de las del usuario';

/**
 * «Controles postoperatorios» (DX-566): la lista de llamadas del día tras los
 * procedimientos que lo piden, su contador y el registro del desenlace. El
 * control se crea solo al marcar hecho el procedimiento (PATCH del ítem).
 */
@ApiTags('post-op-checks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...POST_OP_CHECK_LIST_ROLES)
@Controller('post-op-checks')
export class PostOpChecksController {
  constructor(
    private readonly postOpChecks: PostOpChecksUseCases,
    private readonly tenantContext: TenantContextService,
  ) {}

  // Lleva el nombre y el teléfono de cada paciente: queda auditada (VIEW).
  @Audit({
    action: 'VIEW',
    resource: 'POST_OP_CHECK',
    reason: 'POST_OP_CHECK_LIST',
  })
  @Get()
  @ApiOperation({
    summary: 'Lista de llamadas de control postoperatorio',
    description:
      `${SCOPE} Fila: paciente, teléfono y WhatsApp, profesional, cita e intentos. ` +
      'Los roles clínicos ven además el procedimiento, los intentos con su nota y las indicaciones entregadas en la cita; RECEPTION, no (`clinicalHidden: true`). ' +
      'Deja un `audit_event` VIEW POST_OP_CHECK (POST_OP_CHECK_LIST).',
  })
  @ApiOkResponse({ type: PostOpCheckListDto })
  @ApiBadRequestResponse({ description: 'Filtros o paginación inválidos' })
  @ApiForbiddenResponse({ description: LOCATION_FORBIDDEN })
  list(
    @Query() dto: PostOpChecksQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PostOpCheckList> {
    return this.postOpChecks.list({
      locationId: dto.locationId,
      include: dto.include,
      page: dto.page,
      pageSize: dto.pageSize,
      role: req.user.role,
    });
  }

  @Get('count')
  @ApiOperation({
    summary: 'Contador de «Controles postoperatorios»',
    description: `Los mismos filtros y alcance que la lista, solo los números (sin pacientes, sin auditoría). ${SCOPE}`,
  })
  @ApiOkResponse({ type: PostOpCheckCountDto })
  @ApiBadRequestResponse({ description: 'Filtros inválidos' })
  @ApiForbiddenResponse({ description: LOCATION_FORBIDDEN })
  count(
    @Query() dto: PostOpChecksCountQueryDto,
  ): Promise<PostOpCheckCountView> {
    return this.postOpChecks.count({
      locationId: dto.locationId,
      include: dto.include,
    });
  }

  @Post(':id/attempts')
  @HttpCode(200)
  @Roles(...CLINICAL_ROLES)
  @RolesDeniedMessage(POST_OP_MESSAGES.forbidden)
  @ApiOperation({
    summary: 'Registrar el resultado de una llamada de control',
    description:
      'Bloquea el control. FINE (Bien), DISCOMFORT (Molestias) y NEEDS_APPOINTMENT (Necesita cita) lo cierran (DONE) con ese desenlace; ' +
      'NO_ANSWER (No contesta) añade un intento y al tercero lo cierra como «No localizado» (UNREACHABLE). ' +
      'Al cerrar, en la misma transacción, el desenlace queda en la historia clínica: adenda a la evolución más reciente de la cita (motivo «Control postoperatorio») ' +
      'o, si la cita no tiene evolución (o no hay cita), una evolución nueva con ese motivo ligada a la cita y al paciente; autor = quien registra. ' +
      'Deja un `audit_event` UPDATE POST_OP_CHECK (POST_OP_CHECK_<resultado>, sin la nota). «Necesita cita» solo registra: la cita se agenda aparte.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: PostOpCheckDto })
  @ApiBadRequestResponse({
    description: 'Resultado fuera de la lista o nota de más de 1000 caracteres',
  })
  @ApiForbiddenResponse({
    description: `RECEPTION (${POST_OP_MESSAGES.forbidden}) o control de una sede no permitida`,
  })
  @ApiNotFoundResponse({ description: POST_OP_MESSAGES.notFound })
  @ApiConflictResponse({ description: POST_OP_MESSAGES.closed })
  recordAttempt(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordPostOpAttemptDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PostOpCheckView> {
    return this.postOpChecks.recordAttempt(
      id,
      { outcome: dto.outcome, note: dto.note ?? null },
      { userId: req.user.sub, role: req.user.role },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }
}
