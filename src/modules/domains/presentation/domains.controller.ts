import {
  Body,
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
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiGoneResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { CreateDomainDto } from './dto/create-domain.dto';
import {
  RegisterDomainResponseDto,
  TenantDomainDto,
  VerifyDomainResponseDto,
} from './dto/tenant-domain.dto';
import {
  RegisterDomainUseCase,
  type RegisterDomainResult,
} from '../application/use-cases/register-domain.use-case';
import { ListDomainsUseCase } from '../application/use-cases/list-domains.use-case';
import { VerifyDomainUseCase } from '../application/use-cases/verify-domain.use-case';
import { DeleteDomainUseCase } from '../application/use-cases/delete-domain.use-case';
import type {
  TenantDomainRecord,
  TenantDomainState,
} from '../domain/entities/tenant-domain.entity';

@ApiTags('domains')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
// Dominios personalizados (blanqueo de marca): solo gestión (ADMIN).
@Roles(ClinicRole.ADMIN)
@Controller('domains')
export class DomainsController {
  constructor(
    private readonly registerDomain: RegisterDomainUseCase,
    private readonly listDomains: ListDomainsUseCase,
    private readonly verifyDomain: VerifyDomainUseCase,
    private readonly deleteDomain: DeleteDomainUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  // DX-360: auditado en la transacción del alta (CREATE TENANT_DOMAIN,
  // DOMAIN_REGISTERED) con el host y el estado; nunca el token.
  @Post()
  @ApiOperation({
    summary:
      'Registra un dominio propio en PENDING y devuelve el TXT a publicar (72 h para verificarlo)',
    description:
      'Queda en la auditoría (DOMAIN_REGISTERED) con el host y el estado PENDING; el token de verificación nunca.',
  })
  @ApiCreatedResponse({ type: RegisterDomainResponseDto })
  @ApiBadRequestResponse({
    description: 'No es un dominio personalizado válido',
  })
  @ApiConflictResponse({
    description:
      'Ya está registrado (vivo) en esta clínica, o verificado por otra cuenta',
  })
  create(
    @Body() dto: CreateDomainDto,
    @Req() req: AuditableRequest,
  ): Promise<RegisterDomainResult> {
    return this.registerDomain.execute(
      { host: dto.host },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Get()
  @ApiOkResponse({ type: TenantDomainDto, isArray: true })
  list(): Promise<TenantDomainRecord[]> {
    return this.listDomains.execute();
  }

  // SEC-009: verificar cambia el ruteo (y puede invalidar el PENDING de otra
  // cuenta): auditado.
  @Audit({
    action: 'UPDATE',
    resource: 'TENANT_DOMAIN',
    resourceId: { param: 'id' },
    reason: 'DOMAIN_VERIFICATION',
  })
  @Post(':id/verify')
  @ApiOperation({
    summary:
      'Comprueba el TXT de un dominio PENDING o DISABLED; si está, pasa a VERIFIED',
  })
  @ApiCreatedResponse({ type: VerifyDomainResponseDto })
  @ApiNotFoundResponse({ description: 'No es un dominio de esta clínica' })
  @ApiGoneResponse({
    description: 'El PENDING caducó (72 h) o lo verificó otra cuenta',
  })
  @ApiConflictResponse({ description: 'Otra cuenta lo verificó antes' })
  verify(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ status: TenantDomainState }> {
    return this.verifyDomain.execute({ id });
  }

  @Audit({
    action: 'DELETE',
    resource: 'TENANT_DOMAIN',
    resourceId: { param: 'id' },
  })
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Elimina un dominio de la clínica en cualquier estado: deja de enrutar y libera el host',
  })
  @ApiNoContentResponse({ description: 'Eliminado' })
  @ApiNotFoundResponse({ description: 'No es un dominio de esta clínica' })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.deleteDomain.execute({ id });
  }
}
