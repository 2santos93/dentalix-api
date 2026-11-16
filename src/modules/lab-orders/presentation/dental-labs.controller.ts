import {
  Body,
  Controller,
  Get,
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
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import {
  LAB_CATALOG_READ_ROLES,
  LAB_CATALOG_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { LabCatalogUseCases } from '../application/lab-catalog.use-cases';
import type { DentalLabServiceView, DentalLabView } from '../domain/entities';
import {
  CreateDentalLabDto,
  CreateDentalLabServiceDto,
  DentalLabDto,
  DentalLabServiceDto,
  ListDentalLabsQueryDto,
  UpdateDentalLabDto,
  UpdateDentalLabServiceDto,
} from './dto/lab-catalog.dto';

interface AuthenticatedRequest extends AuditableRequest {
  user: TenantJwtPayload;
}

export const LAB_CATALOG_FORBIDDEN_MESSAGE =
  'Solo un administrador da de alta y cambia los laboratorios dentales y sus servicios.';

/**
 * Laboratorios dentales de la clínica y sus servicios (DX-017). Sin DELETE A
 * PROPÓSITO: se desactivan (la BD tampoco deja borrar). El precio de
 * referencia solo sale para ADMIN.
 */
@ApiTags('dental-labs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...LAB_CATALOG_READ_ROLES)
@Controller('dental-labs')
export class DentalLabsController {
  constructor(
    private readonly catalog: LabCatalogUseCases,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Laboratorios de la clínica con sus servicios, por nombre',
  })
  @ApiOkResponse({ type: [DentalLabDto] })
  list(
    @Query() query: ListDentalLabsQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<DentalLabView[]> {
    return this.catalog.list(query.includeInactive === true, req.user.role);
  }

  // Auditado en el caso de uso (CREATE DENTAL_LAB, DENTAL_LAB_CREATED).
  @Post()
  @Roles(...LAB_CATALOG_WRITE_ROLES)
  @RolesDeniedMessage(LAB_CATALOG_FORBIDDEN_MESSAGE)
  @ApiOperation({ summary: 'Da de alta un laboratorio (solo ADMIN)' })
  @ApiCreatedResponse({ type: DentalLabDto })
  @ApiBadRequestResponse({ description: 'Campos fuera de rango' })
  @ApiConflictResponse({
    description: 'Nombre repetido o tope de 100 laboratorios',
  })
  @ApiForbiddenResponse({ description: LAB_CATALOG_FORBIDDEN_MESSAGE })
  create(
    @Body() dto: CreateDentalLabDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<DentalLabView> {
    return this.catalog.createLab(
      {
        name: dto.name,
        contactName: dto.contactName,
        phone: dto.phone,
        email: dto.email,
        notes: dto.notes,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  // Auditado en el caso de uso (UPDATE DENTAL_LAB con los campos cambiados).
  @Patch(':labId')
  @Roles(...LAB_CATALOG_WRITE_ROLES)
  @RolesDeniedMessage(LAB_CATALOG_FORBIDDEN_MESSAGE)
  @ApiParam({ name: 'labId', format: 'uuid' })
  @ApiOperation({
    summary: 'Cambia o desactiva un laboratorio (solo ADMIN; nunca se borra)',
  })
  @ApiOkResponse({ type: DentalLabDto })
  @ApiBadRequestResponse({ description: 'Campos fuera de rango' })
  @ApiNotFoundResponse({
    description: 'Laboratorio de otra clínica o inexistente',
  })
  @ApiConflictResponse({ description: 'Nombre repetido' })
  @ApiForbiddenResponse({ description: LAB_CATALOG_FORBIDDEN_MESSAGE })
  update(
    @Param('labId', ParseUUIDPipe) labId: string,
    @Body() dto: UpdateDentalLabDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<DentalLabView> {
    return this.catalog.updateLab(
      labId,
      {
        name: dto.name,
        contactName: dto.contactName,
        phone: dto.phone,
        email: dto.email,
        notes: dto.notes,
        active: dto.active,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  // Auditado en el caso de uso (CREATE DENTAL_LAB, DENTAL_LAB_SERVICE_CREATED).
  @Post(':labId/services')
  @Roles(...LAB_CATALOG_WRITE_ROLES)
  @RolesDeniedMessage(LAB_CATALOG_FORBIDDEN_MESSAGE)
  @ApiParam({ name: 'labId', format: 'uuid' })
  @ApiOperation({
    summary: 'Añade un servicio con su plazo en días hábiles (solo ADMIN)',
  })
  @ApiCreatedResponse({ type: DentalLabServiceDto })
  @ApiBadRequestResponse({
    description: 'Plazo fuera de 0–120, precio sin moneda o al revés',
  })
  @ApiNotFoundResponse({
    description: 'Laboratorio de otra clínica o inexistente',
  })
  @ApiConflictResponse({
    description: 'Nombre repetido en el laboratorio o tope de 100 servicios',
  })
  @ApiUnprocessableEntityResponse({ description: 'Moneda inexistente' })
  @ApiForbiddenResponse({ description: LAB_CATALOG_FORBIDDEN_MESSAGE })
  createService(
    @Param('labId', ParseUUIDPipe) labId: string,
    @Body() dto: CreateDentalLabServiceDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<DentalLabServiceView> {
    return this.catalog.createService(
      labId,
      {
        name: dto.name,
        leadTimeBusinessDays: dto.leadTimeBusinessDays,
        referencePrice: dto.referencePrice,
        referenceCurrency: dto.referenceCurrency,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  // Auditado en el caso de uso (UPDATE DENTAL_LAB, DENTAL_LAB_SERVICE_UPDATED).
  @Patch(':labId/services/:serviceId')
  @Roles(...LAB_CATALOG_WRITE_ROLES)
  @RolesDeniedMessage(LAB_CATALOG_FORBIDDEN_MESSAGE)
  @ApiParam({ name: 'labId', format: 'uuid' })
  @ApiParam({ name: 'serviceId', format: 'uuid' })
  @ApiOperation({
    summary: 'Cambia o desactiva un servicio (solo ADMIN; nunca se borra)',
  })
  @ApiOkResponse({ type: DentalLabServiceDto })
  @ApiBadRequestResponse({
    description: 'Plazo fuera de 0–120, precio sin moneda o al revés',
  })
  @ApiNotFoundResponse({
    description: 'Laboratorio o servicio de otra clínica o inexistente',
  })
  @ApiConflictResponse({ description: 'Nombre repetido en el laboratorio' })
  @ApiUnprocessableEntityResponse({ description: 'Moneda inexistente' })
  @ApiForbiddenResponse({ description: LAB_CATALOG_FORBIDDEN_MESSAGE })
  updateService(
    @Param('labId', ParseUUIDPipe) labId: string,
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @Body() dto: UpdateDentalLabServiceDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<DentalLabServiceView> {
    return this.catalog.updateService(
      labId,
      serviceId,
      {
        name: dto.name,
        leadTimeBusinessDays: dto.leadTimeBusinessDays,
        referencePrice: dto.referencePrice,
        referenceCurrency: dto.referenceCurrency,
        active: dto.active,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }
}
