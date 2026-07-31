import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CreatePaymentPlanDto } from './dto/create-payment-plan.dto';
import { PaymentPlanDto } from './dto/payment-plan.dto';
import { CreatePaymentPlanUseCase } from '../application/use-cases/create-payment-plan.use-case';
import {
  GetPaymentPlanUseCase,
  GetPaymentPlanResult,
} from '../application/use-cases/get-payment-plan.use-case';
import { CancelPaymentPlanUseCase } from '../application/use-cases/cancel-payment-plan.use-case';
import { PaymentPlanWithInstallments } from '../domain/entities/payment-plan.entity';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { PAYMENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';

interface AuthenticatedRequest {
  user: JwtPayload;
}

// Financiero -> PAYMENT_ROLES (igual que PaymentsController). Rutas anidadas
// bajo el plan de tratamiento; recurso singular (1 plan de pagos activo).
@ApiTags('payment-plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PAYMENT_ROLES)
@Controller()
export class PaymentPlansController {
  constructor(
    private readonly createPaymentPlan: CreatePaymentPlanUseCase,
    private readonly getPaymentPlan: GetPaymentPlanUseCase,
    private readonly cancelPaymentPlan: CancelPaymentPlanUseCase,
  ) {}

  @Post('treatment-plans/:id/payment-plan')
  @ApiCreatedResponse({ type: PaymentPlanDto })
  create(
    @Param('id') id: string,
    @Body() dto: CreatePaymentPlanDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PaymentPlanWithInstallments> {
    return this.createPaymentPlan.execute(
      id,
      {
        downPayment: dto.downPayment ?? 0,
        installmentsCount: dto.installmentsCount,
        periodicity: dto.periodicity,
        startDate: dto.startDate,
        totalToFinance: dto.totalToFinance,
        notes: dto.notes,
      },
      req.user.sub,
    );
  }

  @Get('treatment-plans/:id/payment-plan')
  @ApiOkResponse({ type: PaymentPlanDto })
  get(@Param('id') id: string): Promise<GetPaymentPlanResult> {
    return this.getPaymentPlan.execute(id);
  }

  @Delete('treatment-plans/:id/payment-plan')
  @HttpCode(204)
  @ApiOkResponse({ description: 'Payment plan cancelled' })
  remove(@Param('id') id: string): Promise<void> {
    return this.cancelPaymentPlan.execute(id);
  }
}
