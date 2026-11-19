import { ExtraPermission } from '@prisma/client';
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
  Put,
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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { AllowPermissions } from '../../auth/presentation/guards/permissions.decorator';
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
  SetPaymentMethodGatewayFeeUseCase,
  UpdatePaymentMethodUseCase,
} from '../application/payment-methods.use-cases';
import type {
  ClinicPaymentMethodEntity,
  PaymentMethodAdjustmentEntity,
} from '../domain/payment-method.entity';
import { PAYMENT_METHODS_ADMIN_MESSAGE } from '../domain/payment-method-rules';
import {
  ListPaymentMethodInstructionsUseCase,
  RemovePaymentMethodInstructionsUseCase,
  SavePaymentMethodInstructionsUseCase,
} from '../application/payment-method-instructions.use-cases';
import type { PaymentMethodInstruction } from '../domain/payment-method-instructions';
import {
  PaymentMethodInstructionDto,
  SavePaymentMethodInstructionsDto,
} from './dto/payment-method-instruction.dto';
import {
  CreatePaymentAdjustmentDto,
  CreatePaymentMethodDto,
  ListPaymentMethodsQueryDto,
  PaymentMethodAdjustmentDto,
  PaymentMethodDto,
  SetPaymentMethodGatewayFeeDto,
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
    private readonly setGatewayFee: SetPaymentMethodGatewayFeeUseCase,
    private readonly listInstructions: ListPaymentMethodInstructionsUseCase,
    private readonly saveInstructions: SavePaymentMethodInstructionsUseCase,
    private readonly removeInstructions: RemovePaymentMethodInstructionsUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @AllowPermissions(ExtraPermission.PAYMENT_REGISTER)
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
        proofPolicy: dto.proofPolicy,
        allowInPaymentLink: dto.allowInPaymentLink,
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
        proofPolicy: dto.proofPolicy,
        allowInPaymentLink: dto.allowInPaymentLink,
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

  // DX-018-bis: % que la pasarela cobra a la clínica por el medio. Solo ADMIN;
  // auditado en la transacción (PAYMENT_METHOD_GATEWAY_FEE_UPDATED, antes y
  // después; sin evento si no cambia).
  @Put(':id/gateway-fee')
  @Roles(...PAYMENT_METHOD_WRITE_ROLES)
  @RolesDeniedMessage(PAYMENT_METHODS_ADMIN_MESSAGE)
  @ApiOperation({
    summary: 'Pone o quita la comisión de la pasarela del medio',
    description:
      'DX-018-bis. Lo que la pasarela cobra a la CLÍNICA por cada cobro con este medio (no es un ajuste al paciente de DX-516). Con «descontar pasarela» en la regla de honorarios, la base cobrada de cada abono se reduce en este %; al cerrar la liquidación queda congelado.',
  })
  @ApiOkResponse({ type: PaymentMethodDto })
  @ApiBadRequestResponse({
    description: 'Porcentaje fuera de (0, 100] o con más de 2 decimales',
  })
  @ApiNotFoundResponse({ description: 'Medio no encontrado en esta clínica' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  gatewayFee(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetPaymentMethodGatewayFeeDto,
    @Req() req: AuditableRequest,
  ): Promise<ClinicPaymentMethodEntity> {
    return this.setGatewayFee.execute(
      id,
      dto.percent,
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  // DX-569: datos para pagar de cada medio (los que ve el paciente en su
  // enlace de pago), de toda la clínica o de una sede. Leerlos: quien cobra;
  // escribirlos: solo ADMIN, auditados en la transacción del cambio
  // (PAYMENT_METHOD, PAYMENT_METHOD_INSTRUCTIONS_*, sin los valores).
  @Get(':id/instructions')
  @ApiOperation({
    summary: 'Datos para pagar del medio (la clínica y cada sede)',
    description:
      'DX-569. La fila sin sede rige en toda la clínica; la de una sede gana en esa sede.',
  })
  @ApiOkResponse({ type: [PaymentMethodInstructionDto] })
  @ApiNotFoundResponse({ description: 'Medio no encontrado en esta clínica' })
  @ApiForbiddenResponse({ description: 'Rol sin acceso a pagos' })
  instructions(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PaymentMethodInstruction[]> {
    return this.listInstructions.execute(id);
  }

  @Put(':id/instructions')
  @Roles(...PAYMENT_METHOD_WRITE_ROLES)
  @RolesDeniedMessage(PAYMENT_METHODS_ADMIN_MESSAGE)
  @ApiOperation({
    summary:
      'Guarda los datos para pagar del medio en una sede o en la clínica',
    description:
      'DX-569. Sustituye la fila de ese ámbito (sin `locationId`, la de toda la clínica): un campo ausente o en blanco queda vacío y al menos uno tiene que llevar texto. Para una sede hace falta acceso a ella (403 LOCATION_NOT_ALLOWED). Auditado como PAYMENT_METHOD (solo qué campos cambiaron, nunca sus valores).',
  })
  @ApiOkResponse({ type: PaymentMethodInstructionDto })
  @ApiBadRequestResponse({
    description:
      'Ningún dato con texto, un campo demasiado largo o con saltos de línea, o una sede que no es de la clínica',
  })
  @ApiNotFoundResponse({ description: 'Medio no encontrado en esta clínica' })
  @ApiForbiddenResponse({
    description: 'Solo ADMIN, o sede no permitida al usuario',
  })
  saveMethodInstructions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SavePaymentMethodInstructionsDto,
    @Req() req: AuditableRequest,
  ): Promise<PaymentMethodInstruction> {
    return this.saveInstructions.execute(
      id,
      {
        locationId: dto.locationId,
        holderName: dto.holderName,
        holderId: dto.holderId,
        bankName: dto.bankName,
        accountNumber: dto.accountNumber,
        phone: dto.phone,
        email: dto.email,
        note: dto.note,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Delete(':id/instructions/:instructionId')
  @HttpCode(204)
  @Roles(...PAYMENT_METHOD_WRITE_ROLES)
  @RolesDeniedMessage(PAYMENT_METHODS_ADMIN_MESSAGE)
  @ApiOperation({
    summary: 'Quita los datos para pagar de una sede (o los de la clínica)',
    description:
      'DX-569. Sin los de la sede, en ella rigen los de la clínica. Auditado como PAYMENT_METHOD.',
  })
  @ApiNoContentResponse({ description: 'Quitados' })
  @ApiNotFoundResponse({ description: 'Medio o datos no encontrados' })
  @ApiForbiddenResponse({
    description: 'Solo ADMIN, o sede no permitida al usuario',
  })
  async removeMethodInstructions(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('instructionId', ParseUUIDPipe) instructionId: string,
    @Req() req: AuditableRequest,
  ): Promise<void> {
    await this.removeInstructions.execute(
      id,
      instructionId,
      requireAuditRequestContext(req, this.tenantContext),
    );
  }
}
