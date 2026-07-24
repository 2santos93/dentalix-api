import {
  Body,
  Controller,
  Delete,
  Get,
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
import { RecordPaymentDto } from './dto/record-payment.dto';
import { PaymentDto } from './dto/payment.dto';
import { PlanBalanceDto } from './dto/plan-balance.dto';
import { RecordPaymentUseCase } from '../application/use-cases/record-payment.use-case';
import { ListPaymentsUseCase } from '../application/use-cases/list-payments.use-case';
import { VoidPaymentUseCase } from '../application/use-cases/void-payment.use-case';
import {
  GetPlanBalanceUseCase,
  GetPlanBalanceResult,
} from '../application/use-cases/get-plan-balance.use-case';
import { Payment } from '../domain/entities/payment.entity';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { PAYMENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';

interface AuthenticatedRequest {
  user: JwtPayload;
}

// Pagos/abonos es dato FINANCIERO -> @Roles(...PAYMENT_ROLES) (OWNER/ADMIN +
// RECEPTION -- mostrador + gestión; DENTIST/ASSISTANT NO, ver
// docs/plans/2026-07-24-payments-pivot.md "Global Constraints"). No
// `@Controller(prefix)` base: routes mix a plan-nested path
// (`treatment-plans/:id/payments`, `.../balance`) with a top-level path keyed
// by payment id (`payments/:id` for void), so each method declares its own
// full path (same rationale as TreatmentPlansController mixing
// `patients/:patientId/treatment-plans` with `treatment-plans/:id[/items]`).
@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PAYMENT_ROLES)
@Controller()
export class PaymentsController {
  constructor(
    private readonly recordPayment: RecordPaymentUseCase,
    private readonly listPayments: ListPaymentsUseCase,
    private readonly voidPayment: VoidPaymentUseCase,
    private readonly getPlanBalance: GetPlanBalanceUseCase,
  ) {}

  @Post('treatment-plans/:id/payments')
  @ApiCreatedResponse({ type: PaymentDto })
  create(
    @Param('id') id: string,
    @Body() dto: RecordPaymentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<Payment> {
    // `createdById` comes from the authenticated user (req.user.sub), never
    // from the client body -- same convention as
    // AppointmentsController.create / TreatmentPlansController.create.
    return this.recordPayment.execute(
      id,
      {
        amount: dto.amount,
        currency: dto.currency,
        paidAt: dto.paidAt,
        method: dto.method,
        notes: dto.notes,
      },
      req.user.sub,
    );
  }

  @Get('treatment-plans/:id/payments')
  @ApiOkResponse({ type: [PaymentDto] })
  list(@Param('id') id: string): Promise<Payment[]> {
    return this.listPayments.execute(id);
  }

  @Get('treatment-plans/:id/balance')
  @ApiOkResponse({ type: PlanBalanceDto })
  balance(@Param('id') id: string): Promise<GetPlanBalanceResult> {
    return this.getPlanBalance.execute(id);
  }

  @Delete('payments/:id')
  @ApiOkResponse({ description: 'Payment voided (deletedAt set)' })
  remove(@Param('id') id: string): Promise<void> {
    return this.voidPayment.execute(id);
  }
}
