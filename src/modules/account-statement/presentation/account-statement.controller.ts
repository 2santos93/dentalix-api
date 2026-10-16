import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AccountStatementDto } from './dto/account-statement.dto';
import { AccountStatementQueryDto } from './dto/account-statement-query.dto';
import { BillablePlanDto } from './dto/billable-plan.dto';
import { GetAccountStatementUseCase } from '../application/use-cases/get-account-statement.use-case';
import { ListBillablePlansUseCase } from '../application/use-cases/list-billable-plans.use-case';
import { AccountStatement } from '../domain/entities/account-statement.entity';
import { BillablePlan } from '../domain/entities/billable-plan.entity';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { PAYMENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';

// Estado de cuenta = el mismo dato FINANCIERO que pagos y planes de pago, visto
// por paciente -> exactamente PAYMENT_ROLES (ADMIN + RECEPTION), como
// PaymentsController y PaymentPlansController. DENTIST/ASSISTANT: 403.
@ApiTags('account-statement')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PAYMENT_ROLES)
@Controller()
export class AccountStatementController {
  constructor(
    private readonly getAccountStatement: GetAccountStatementUseCase,
    private readonly listBillablePlans: ListBillablePlansUseCase,
  ) {}

  @Audit({
    action: 'VIEW',
    resource: 'ACCOUNT_STATEMENT',
    patient: { param: 'patientId' },
  })
  @Get('patients/:patientId/account-statement')
  @ApiOperation({
    summary:
      'Estado de cuenta del paciente: presupuestado, abonado, saldo y cuotas por moneda',
    description:
      'Totales de toda la historia del paciente (todas las sedes). `from`/`to` ' +
      'acotan solo la lista de movimientos. Sin datos clínicos.',
  })
  @ApiParam({ name: 'patientId', format: 'uuid' })
  @ApiOkResponse({ type: AccountStatementDto })
  @ApiBadRequestResponse({
    description: 'patientId no es UUID, fecha inválida o from > to',
  })
  @ApiForbiddenResponse({ description: 'Rol sin acceso a pagos' })
  @ApiNotFoundResponse({
    description:
      'Paciente no encontrado en esta clínica (inexistente o de otra clínica).',
  })
  get(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Query() query: AccountStatementQueryDto,
    @Req() req: { user: TenantJwtPayload },
  ): Promise<AccountStatement> {
    return this.getAccountStatement.execute(
      patientId,
      { from: query.from, to: query.to },
      // `canVoid` de cada movimiento se calcula para quien consulta (token).
      { userId: req.user.sub, role: req.user.role },
    );
  }

  // DX-067: recepción registra abonos y planes de cuotas desde el estado de
  // cuenta, sin poder listar planes de tratamiento (CLINICAL_ROLES). Mismos
  // roles que el estado de cuenta y que POST .../payments y .../payment-plan.
  @Audit({
    action: 'VIEW',
    resource: 'TREATMENT_PLAN',
    patient: { param: 'patientId' },
  })
  @Get('patients/:patientId/billable-plans')
  @ApiOperation({
    summary:
      'Planes cobrables del paciente: total, abonado y saldo, sin datos clínicos',
    description:
      'Planes no cancelados con algo facturable (ítems ACCEPTED|DONE), de ' +
      'todas las sedes, del más reciente al más antiguo. Es lo que necesita ' +
      'quien cobra para elegir el plan de un abono (`POST ' +
      '/treatment-plans/:id/payments`) o de un plan de cuotas (`POST ' +
      '/treatment-plans/:id/payment-plan`). No incluye ítems, dientes, ' +
      'procedimientos ni notas. Lista vacía si el paciente no tiene nada que ' +
      'cobrar.',
  })
  @ApiParam({ name: 'patientId', format: 'uuid' })
  @ApiOkResponse({ type: [BillablePlanDto] })
  @ApiBadRequestResponse({ description: 'patientId no es UUID' })
  @ApiForbiddenResponse({ description: 'Rol sin acceso a pagos' })
  @ApiNotFoundResponse({
    description:
      'Paciente no encontrado en esta clínica (inexistente o de otra clínica).',
  })
  billablePlans(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<BillablePlan[]> {
    return this.listBillablePlans.execute(patientId);
  }
}
