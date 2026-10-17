import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ListStaffUseCase } from '../application/use-cases/list-staff.use-case';
import { ListStaffDirectoryUseCase } from '../application/use-cases/list-staff-directory.use-case';
import {
  GetStaffDetailUseCase,
  type StaffMemberDetail,
} from '../application/use-cases/get-staff-detail.use-case';
import { UnlockStaffLoginUseCase } from '../application/use-cases/unlock-staff-login.use-case';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { ReactivateStaffUseCase } from '../application/use-cases/reactivate-staff.use-case';
import { UpdateStaffUseCase } from '../application/use-cases/update-staff.use-case';
import { DeactivateStaffUseCase } from '../application/use-cases/deactivate-staff.use-case';
import { StaffMember } from '../domain/entities/staff-member.entity';
import { StaffMemberDto } from './dto/staff-member.dto';
import {
  StaffDirectoryPageDto,
  StaffMemberDetailDto,
} from './dto/staff-directory.dto';
import { ListStaffDirectoryQueryDto } from './dto/list-staff-directory-query.dto';
import { StaffDirectoryPage } from '../domain/entities/staff-directory-entry.entity';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  PATIENT_ROLES,
  STAFF_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { JwtPayload } from '../../../shared/crypto/token.service';

interface AuthenticatedRequest {
  user: JwtPayload;
}

// GET /staff feeds the appointments provider selector — every role that can
// touch the agenda (or just needs to see who's on staff) can read it, so it
// reuses PATIENT_ROLES (all 5) rather than a bespoke set.
//
// PATCH/DELETE (staff management) are narrower: RolesGuard reads
// @Roles metadata via getAllAndOverride([handler, class]) (see
// roles.guard.ts), so the per-method @Roles(...STAFF_WRITE_ROLES) below
// correctly overrides the class-level @Roles(...PATIENT_ROLES) for those
// two routes, while GET keeps the class-level PATIENT_ROLES.
@ApiTags('staff')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PATIENT_ROLES)
@Controller('staff')
export class StaffController {
  constructor(
    private readonly listStaff: ListStaffUseCase,
    private readonly listDirectory: ListStaffDirectoryUseCase,
    private readonly getStaffDetail: GetStaffDetailUseCase,
    private readonly updateStaff: UpdateStaffUseCase,
    private readonly deactivateStaff: DeactivateStaffUseCase,
    private readonly reactivateStaff: ReactivateStaffUseCase,
    private readonly unlockLogin: UnlockStaffLoginUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  // Sigue SIN paginar a propósito: alimenta selectores (profesional de la
  // cita, filtro de la agenda, dashboard) que necesitan la lista entera. La
  // pantalla de gestión usa /staff/directory.
  @Get()
  @ApiOkResponse({ type: [StaffMemberDto] })
  list(): Promise<StaffMember[]> {
    return this.listStaff.execute();
  }

  // DEBE declararse antes que `@Get(':userId')`: Nest resuelve por orden de
  // declaración y si no, "directory" entraría como userId (y moriría en el
  // ParseUUIDPipe con un 400 en vez de listar).
  @Get('directory')
  @Roles(...STAFF_WRITE_ROLES)
  @ApiOkResponse({ type: StaffDirectoryPageDto })
  directory(
    @Query() query: ListStaffDirectoryQueryDto,
  ): Promise<StaffDirectoryPage> {
    return this.listDirectory.execute({
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
      search: query.search,
      role: query.role,
      status: query.status,
    });
  }

  @Get(':userId')
  @Roles(...STAFF_WRITE_ROLES)
  @ApiOkResponse({ type: StaffMemberDetailDto })
  detail(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<StaffMemberDetail> {
    return this.getStaffDetail.execute(userId);
  }

  @Patch(':userId')
  @Roles(...STAFF_WRITE_ROLES)
  @ApiOkResponse({ type: StaffMemberDto })
  update(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateStaffDto,
  ): Promise<StaffMember> {
    return this.updateStaff.execute({ userId, ...dto });
  }

  // 200, no el 201 que Nest da por defecto en POST: reactivar no crea ningún
  // recurso, resucita una membresía que ya existía.
  @Post(':userId/reactivate')
  @Roles(...STAFF_WRITE_ROLES)
  @HttpCode(200)
  @ApiOkResponse({ type: StaffMemberDto })
  reactivate(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<StaffMember> {
    return this.reactivateStaff.execute(userId);
  }

  // DX-048: quitar el bloqueo por intentos fallidos de un miembro de ESTA
  // clínica (otra clínica → 404 bajo RLS; otro rol → 403). Auditado.
  // DX-213: solo miembros activos (desactivado → 404) cuya cuenta no dé
  // acceso a otra clínica (→ 409); el rechazo lo audita el caso de uso.
  @Audit({
    action: 'UPDATE',
    resource: 'STAFF_MEMBER',
    resourceId: { param: 'userId' },
    reason: 'LOGIN_UNLOCKED',
  })
  @Post(':userId/login-unlock')
  @Roles(...STAFF_WRITE_ROLES)
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Desbloquea el inicio de sesión de un miembro (borra la espera y los intentos fallidos)',
    description:
      'Solo para miembros activos de esta clínica cuya cuenta no da acceso a ninguna otra: el bloqueo es por cuenta, no por clínica. Un rechazo queda auditado (LOGIN_UNLOCK_REFUSED) sin tocar el contador.',
  })
  @ApiNoContentResponse({ description: 'Desbloqueado (o no estaba bloqueado)' })
  @ApiNotFoundResponse({
    description:
      'No es miembro de esta clínica o su membresía está desactivada; el contador no cambia',
  })
  @ApiConflictResponse({
    description:
      'La cuenta da acceso a otra clínica (sin decir cuál ni cuántas); el contador no cambia. Mensaje: «Esta cuenta da acceso a otra clínica: pide a la persona que espere unos minutos o que restablezca su contraseña»',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  async unlockLoginHandler(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() req: AuditableRequest,
  ): Promise<void> {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    await this.unlockLogin.execute(userId, ctx);
  }

  @Delete(':userId')
  @Roles(...STAFF_WRITE_ROLES)
  @HttpCode(204)
  async remove(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.deactivateStaff.execute({
      userId,
      requestingUserId: req.user.sub,
    });
  }
}
