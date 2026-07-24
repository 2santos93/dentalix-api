import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
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
import { CreateSaleDto } from './dto/create-sale.dto';
import { ListSalesQueryDto } from './dto/list-sales-query.dto';
import { SalesTotalsQueryDto } from './dto/sales-totals-query.dto';
import { SaleDto } from './dto/sale.dto';
import { SalesTotalsDto } from './dto/sales-totals.dto';
import { CreateSaleUseCase } from '../application/use-cases/create-sale.use-case';
import { ListSalesUseCase } from '../application/use-cases/list-sales.use-case';
import { GetSaleUseCase } from '../application/use-cases/get-sale.use-case';
import { VoidSaleUseCase } from '../application/use-cases/void-sale.use-case';
import {
  GetSalesTotalsUseCase,
  GetSalesTotalsResult,
} from '../application/use-cases/get-sales-totals.use-case';
import { Sale, SaleWithLineItems } from '../domain/entities/sale.entity';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { SALES_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';

interface AuthenticatedRequest {
  user: JwtPayload;
}

// Ventas/pagos es dato FINANCIERO -> @Roles(...SALES_ROLES) (OWNER/ADMIN +
// RECEPTION -- facturación de mostrador + gestión; DENTIST/ASSISTANT NO, ver
// docs/plans/2026-07-24-sales.md "Global Constraints"). `GET
// sales/totals` is declared BEFORE `GET sales/:id` -- Nest/Express match
// routes in registration order, and `:id` would otherwise swallow the
// literal `totals` segment (same pitfall AppointmentsController /
// TreatmentPlansController avoid by never mixing a literal sibling route
// with a same-prefix `:id` route in the wrong order).
@ApiTags('sales')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...SALES_ROLES)
@Controller('sales')
export class SalesController {
  constructor(
    private readonly createSale: CreateSaleUseCase,
    private readonly listSales: ListSalesUseCase,
    private readonly getSale: GetSaleUseCase,
    private readonly voidSale: VoidSaleUseCase,
    private readonly getSalesTotals: GetSalesTotalsUseCase,
  ) {}

  @Post()
  @ApiCreatedResponse({ type: SaleDto })
  create(
    @Body() dto: CreateSaleDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<SaleWithLineItems> {
    // `createdById` comes from the authenticated user (req.user.sub), never
    // from the client body -- same convention as
    // AppointmentsController.create / TreatmentPlansController.create.
    return this.createSale.execute(
      {
        patientId: dto.patientId,
        currency: dto.currency,
        paidAt: dto.paidAt,
        paymentMethod: dto.paymentMethod,
        notes: dto.notes,
        lineItems: dto.lineItems.map((line) => ({
          description: line.description,
          catalogItemId: line.catalogItemId,
          treatmentPlanItemId: line.treatmentPlanItemId,
          unitPrice: line.unitPrice,
          quantity: line.quantity,
        })),
      },
      req.user.sub,
    );
  }

  @Get('totals')
  @ApiOkResponse({ type: SalesTotalsDto })
  totals(@Query() query: SalesTotalsQueryDto): Promise<GetSalesTotalsResult> {
    return this.getSalesTotals.execute({
      from: new Date(query.from),
      to: new Date(query.to),
      currency: query.currency,
    });
  }

  @Get()
  @ApiOkResponse({ type: [SaleDto] })
  list(@Query() query: ListSalesQueryDto): Promise<Sale[]> {
    return this.listSales.execute({
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      patientId: query.patientId,
    });
  }

  @Get(':id')
  @ApiOkResponse({ type: SaleDto })
  get(@Param('id') id: string): Promise<SaleWithLineItems> {
    return this.getSale.execute(id);
  }

  @Delete(':id')
  @ApiOkResponse({ description: 'Sale voided (deletedAt set)' })
  remove(@Param('id') id: string): Promise<void> {
    return this.voidSale.execute(id);
  }
}
