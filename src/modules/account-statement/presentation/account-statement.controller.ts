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
import { GetAccountStatementUseCase } from '../application/use-cases/get-account-statement.use-case';
import { AccountStatement } from '../domain/entities/account-statement.entity';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { PAYMENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';

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
  ) {}

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
}
