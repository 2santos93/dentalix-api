import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
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
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { TREATMENT_PLAN_QUOTE_READ_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import { SimulateInstallmentsUseCase } from '../application/use-cases/simulate-installments.use-case';
import {
  InstallmentSimulationDto,
  InstallmentSimulationRequestDto,
} from './dto/installment-simulation.dto';

/**
 * DX-041: «Financiar» del presupuesto. Simula planes de cuotas sin guardar
 * nada; los mismos roles que imprimen el presupuesto, porque el PDF lleva los
 * escenarios. Crear el plan de cuotas sigue siendo POST …/payment-plan
 * (cobro) o la aceptación con `installmentPlan` (quien acepta).
 */
@ApiTags('payment-plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Controller()
export class InstallmentSimulationController {
  constructor(private readonly simulate: SimulateInstallmentsUseCase) {}

  // Lee el plan (VIEW): enseña su saldo. No escribe nada más que el evento.
  @Audit({
    action: 'VIEW',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'id' },
    patient: { lookup: 'treatmentPlan', param: 'id' },
    reason: 'INSTALLMENT_SIMULATION',
  })
  @Post('treatment-plans/:id/installment-simulation')
  @HttpCode(200)
  @Roles(...TREATMENT_PLAN_QUOTE_READ_ROLES)
  @ApiOperation({
    summary: 'Simula hasta 3 planes de cuotas del presupuesto (DX-041)',
    description:
      'Sin persistir nada. Cada escenario (cuota inicial, número de cuotas, periodicidad y fecha de la 1ª cuota) devuelve exactamente las cuotas y fechas que crearía POST …/payment-plan con los mismos datos, sobre el saldo que se financiaría al aceptar (lo cobrable del plan contando sus propuestos como aceptados). La inicial más las cuotas suman ese saldo; el ajuste de redondeo va en la última cuota. Para aceptar con uno: POST …/acceptance con `installmentPlan` (sus condiciones y `totalToFinance`).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: InstallmentSimulationDto })
  @ApiBadRequestResponse({
    description:
      'Id que no es UUID; ninguno o más de 3 escenarios; cuotas fuera de 1–600, periodicidad o fecha no válidas; cuota inicial negativa o mayor que el saldo; saldo 0 (plan sin importes)',
  })
  @ApiNotFoundResponse({
    description: 'Plan no encontrado en esta clínica',
  })
  @ApiConflictResponse({
    description:
      'El plan está rechazado o cancelado (no se financia) o ya tiene un plan de cuotas activo',
  })
  @ApiUnprocessableEntityResponse({
    description: 'La moneda del plan no está en el catálogo de monedas',
  })
  @ApiForbiddenResponse({
    description: 'Rol sin acceso al presupuesto',
  })
  async simulateInstallments(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InstallmentSimulationRequestDto,
  ): Promise<InstallmentSimulationDto> {
    return this.simulate.execute(
      id,
      dto.scenarios.map((s) => ({
        downPayment: s.downPayment ?? 0,
        installmentsCount: s.installmentsCount,
        periodicity: s.periodicity,
        startDate: s.startDate,
      })),
    );
  }
}
