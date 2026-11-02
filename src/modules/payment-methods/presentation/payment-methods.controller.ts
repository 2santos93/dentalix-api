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
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import {
  PAYMENT_METHOD_WRITE_ROLES,
  PAYMENT_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import {
  CreatePaymentAdjustmentUseCase,
  CreatePaymentMethodUseCase,
  ListPaymentMethodsUseCase,
  UpdatePaymentAdjustmentUseCase,
  UpdatePaymentMethodUseCase,
} from '../application/payment-methods.use-cases';
import type {
  ClinicPaymentMethodEntity,
  PaymentMethodAdjustmentEntity,
} from '../domain/payment-method.entity';
import { PAYMENT_METHODS_ADMIN_MESSAGE } from '../domain/payment-method-rules';
import {
  CreatePaymentAdjustmentDto,
  CreatePaymentMethodDto,
  ListPaymentMethodsQueryDto,
  PaymentMethodAdjustmentDto,
  PaymentMethodDto,
  UpdatePaymentAdjustmentDto,
  UpdatePaymentMethodDto,
} from './dto/payment-method.dto';

interface AuthenticatedRequest {
  user: TenantJwtPayload;
}

// Medios de pago de la clínica (DX-377). Leerlos: quien cobra (PAYMENT_ROLES,
// el selector del modal de abono). Crear y editar (también desactivar): solo
// ADMIN, con 403 en español. No se borran: un abono antiguo los referencia.
@ApiTags('payment-methods')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PAYMENT_ROLES)
@Controller('payment-methods')
export class PaymentMethodsController {
  constructor(
    private readonly listMethods: ListPaymentMethodsUseCase,
    private readonly createMethod: CreatePaymentMethodUseCase,
    private readonly updateMethod: UpdatePaymentMethodUseCase,
    private readonly createAdjustment: CreatePaymentAdjustmentUseCase,
    private readonly updateAdjustment: UpdatePaymentAdjustmentUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOkResponse({ type: [PaymentMethodDto] })
  @ApiForbiddenResponse({ description: 'Rol sin acceso a pagos' })
  list(
    @Query() query: ListPaymentMethodsQueryDto,
  ): Promise<ClinicPaymentMethodEntity[]> {
    return this.listMethods.execute({ includeInactive: query.includeInactive });
  }

  @Audit({
    action: 'CREATE',
    resource: 'PAYMENT_METHOD',
    resourceId: { response: 'id' },
  })
  @Post()
  @Roles(...PAYMENT_METHOD_WRITE_ROLES)
  @RolesDeniedMessage(PAYMENT_METHODS_ADMIN_MESSAGE)
  @ApiCreatedResponse({ type: PaymentMethodDto })
  @ApiBadRequestResponse({ description: 'Nombre vacío o tipo desconocido' })
  @ApiConflictResponse({ description: 'Ya existe un medio con ese nombre' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  create(
    @Body() dto: CreatePaymentMethodDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ClinicPaymentMethodEntity> {
    return this.createMethod.execute(
      {
        name: dto.name,
        kind: dto.kind,
        active: dto.active,
        requiresReference: dto.requiresReference,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'PAYMENT_METHOD',
    resourceId: { param: 'id' },
  })
  @Patch(':id')
  @Roles(...PAYMENT_METHOD_WRITE_ROLES)
  @RolesDeniedMessage(PAYMENT_METHODS_ADMIN_MESSAGE)
  @ApiOkResponse({ type: PaymentMethodDto })
  @ApiBadRequestResponse({
    description:
      'Campo inválido, o cambio del tipo base de un medio inicial (DX-377).',
  })
  @ApiNotFoundResponse({ description: 'Medio no encontrado en esta clínica' })
  @ApiConflictResponse({ description: 'Ya existe un medio con ese nombre' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentMethodDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ClinicPaymentMethodEntity> {
    return this.updateMethod.execute(
      id,
      {
        name: dto.name,
        kind: dto.kind,
        active: dto.active,
        requiresReference: dto.requiresReference,
      },
      req.user.sub,
    );
  }

  // DX-516: ajustes por medio de pago (impuesto, recargo o descuento). Solo
  // ADMIN; auditados en la transacción del cambio (DX-360: PAYMENT_METHOD
  // PAYMENT_METHOD_ADJUSTMENT_CREATED/UPDATED con el antes y el después).
  @Post(':id/adjustments')
  @Roles(...PAYMENT_METHOD_WRITE_ROLES)
  @RolesDeniedMessage(PAYMENT_METHODS_ADMIN_MESSAGE)
  @ApiCreatedResponse({ type: PaymentMethodAdjustmentDto })
  @ApiBadRequestResponse({
    description:
      'Etiqueta vacía o larga, porcentaje fuera de (0, 100], importe fijo sin moneda o con más decimales que su moneda.',
  })
  @ApiNotFoundResponse({ description: 'Medio no encontrado en esta clínica' })
  @ApiConflictResponse({
    description: 'Etiqueta repetida en el medio o tope de ajustes activos',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  addAdjustment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePaymentAdjustmentDto,
    @Req() req: AuditableRequest,
  ): Promise<PaymentMethodAdjustmentEntity> {
    return this.createAdjustment.execute(
      id,
      {
        type: dto.type,
        label: dto.label,
        calculation: dto.calculation,
        percent: dto.percent,
        fixedAmount: dto.fixedAmount,
        fixedCurrency: dto.fixedCurrency,
        active: dto.active,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Patch(':id/adjustments/:adjustmentId')
  @Roles(...PAYMENT_METHOD_WRITE_ROLES)
  @RolesDeniedMessage(PAYMENT_METHODS_ADMIN_MESSAGE)
  @ApiOkResponse({ type: PaymentMethodAdjustmentDto })
  @ApiBadRequestResponse({ description: 'Campo inválido (como en el alta).' })
  @ApiNotFoundResponse({ description: 'Medio o ajuste no encontrado' })
  @ApiConflictResponse({
    description: 'Etiqueta repetida en el medio o tope de ajustes activos',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  changeAdjustment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('adjustmentId', ParseUUIDPipe) adjustmentId: string,
    @Body() dto: UpdatePaymentAdjustmentDto,
    @Req() req: AuditableRequest,
  ): Promise<PaymentMethodAdjustmentEntity> {
    return this.updateAdjustment.execute(
      id,
      adjustmentId,
      {
        type: dto.type,
        label: dto.label,
        calculation: dto.calculation,
        percent: dto.percent,
        fixedAmount: dto.fixedAmount,
        fixedCurrency: dto.fixedCurrency,
        active: dto.active,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }
}
