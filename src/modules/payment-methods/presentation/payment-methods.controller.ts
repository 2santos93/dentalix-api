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
import {
  CreatePaymentMethodUseCase,
  ListPaymentMethodsUseCase,
  UpdatePaymentMethodUseCase,
} from '../application/payment-methods.use-cases';
import type { ClinicPaymentMethodEntity } from '../domain/payment-method.entity';
import { PAYMENT_METHODS_ADMIN_MESSAGE } from '../domain/payment-method-rules';
import {
  CreatePaymentMethodDto,
  ListPaymentMethodsQueryDto,
  PaymentMethodDto,
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
}
