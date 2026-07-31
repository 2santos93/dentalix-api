import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
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
import { CreateTreatmentPlanDto } from './dto/create-treatment-plan.dto';
import { UpdateTreatmentPlanDto } from './dto/update-treatment-plan.dto';
import { AddTreatmentPlanItemDto } from './dto/add-treatment-plan-item.dto';
import { UpdateTreatmentPlanItemDto } from './dto/update-treatment-plan-item.dto';
import { TreatmentPlanDto } from './dto/treatment-plan.dto';
import { TreatmentPlanItemDto } from './dto/treatment-plan-item.dto';
import { CreateTreatmentPlanUseCase } from '../application/use-cases/create-treatment-plan.use-case';
import { ListTreatmentPlansUseCase } from '../application/use-cases/list-treatment-plans.use-case';
import { GetTreatmentPlanUseCase } from '../application/use-cases/get-treatment-plan.use-case';
import { UpdateTreatmentPlanUseCase } from '../application/use-cases/update-treatment-plan.use-case';
import { AddTreatmentPlanItemUseCase } from '../application/use-cases/add-treatment-plan-item.use-case';
import { UpdateTreatmentPlanItemUseCase } from '../application/use-cases/update-treatment-plan-item.use-case';
import { RemoveTreatmentPlanItemUseCase } from '../application/use-cases/remove-treatment-plan-item.use-case';
import {
  TreatmentPlan,
  TreatmentPlanDetail,
} from '../domain/entities/treatment-plan.entity';
import { TreatmentPlanItem } from '../domain/entities/treatment-plan-item.entity';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { CLINICAL_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';

interface AuthenticatedRequest {
  user: JwtPayload;
}

// Plan de tratamiento es dato CLÍNICO -> @Roles(...CLINICAL_ROLES) (OWNER/
// DENTIST/ASSISTANT/ADMIN, NO recepción — ver docs/plans/2026-07-24-treatment-plans.md
// "Global Constraints"). No `@Controller(prefix)` base: routes mix a
// patient-nested path (`patients/:patientId/treatment-plans`) with top-level
// paths keyed by plan/item id (`treatment-plans/:id[/items/:itemId]`), so each
// method declares its own full path (same rationale as
// AppointmentsController mixing bare `/appointments` — here it's two
// different prefixes instead of one, so a single class-level prefix can't
// cover both).
@ApiTags('treatment-plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@Controller()
export class TreatmentPlansController {
  constructor(
    private readonly createTreatmentPlan: CreateTreatmentPlanUseCase,
    private readonly listTreatmentPlans: ListTreatmentPlansUseCase,
    private readonly getTreatmentPlan: GetTreatmentPlanUseCase,
    private readonly updateTreatmentPlan: UpdateTreatmentPlanUseCase,
    private readonly addTreatmentPlanItem: AddTreatmentPlanItemUseCase,
    private readonly updateTreatmentPlanItem: UpdateTreatmentPlanItemUseCase,
    private readonly removeTreatmentPlanItem: RemoveTreatmentPlanItemUseCase,
  ) {}

  @Post('patients/:patientId/treatment-plans')
  @ApiCreatedResponse({ type: TreatmentPlanDto })
  create(
    @Param('patientId') patientId: string,
    @Body() dto: CreateTreatmentPlanDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<TreatmentPlan> {
    // `createdById` comes from the authenticated user (req.user.sub), never
    // from the client body — same convention as AppointmentsController.create
    // / OdontogramController.create.
    return this.createTreatmentPlan.execute({
      patientId,
      currency: dto.currency,
      notes: dto.notes,
      createdById: req.user.sub,
    });
  }

  @Get('patients/:patientId/treatment-plans')
  @ApiOkResponse({ type: [TreatmentPlanDto] })
  list(@Param('patientId') patientId: string): Promise<TreatmentPlan[]> {
    return this.listTreatmentPlans.execute(patientId);
  }

  @Get('treatment-plans/:id')
  @ApiOkResponse({ type: TreatmentPlanDto })
  get(@Param('id') id: string): Promise<TreatmentPlanDetail> {
    return this.getTreatmentPlan.execute(id);
  }

  @Patch('treatment-plans/:id')
  @ApiOkResponse({ type: TreatmentPlanDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTreatmentPlanDto,
  ): Promise<TreatmentPlan> {
    return this.updateTreatmentPlan.execute(id, {
      status: dto.status,
      currency: dto.currency,
      notes: dto.notes,
    });
  }

  @Post('treatment-plans/:id/items')
  @ApiCreatedResponse({ type: TreatmentPlanItemDto })
  addItem(
    @Param('id') id: string,
    @Body() dto: AddTreatmentPlanItemDto,
  ): Promise<TreatmentPlanItem> {
    return this.addTreatmentPlanItem.execute(id, {
      toothNumber: dto.toothNumber,
      surfaces: dto.surfaces,
      catalogItemId: dto.catalogItemId,
      price: dto.price,
      notes: dto.notes,
    });
  }

  @Patch('treatment-plans/:id/items/:itemId')
  @ApiOkResponse({ type: TreatmentPlanItemDto })
  updateItem(
    @Param('itemId') itemId: string,
    @Body() dto: UpdateTreatmentPlanItemDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<TreatmentPlanItem> {
    // `performedById` (req.user.sub) stamps the odontogram record auto-created
    // when this item is marked DONE (Pieza B) — never from the client body.
    return this.updateTreatmentPlanItem.execute(
      itemId,
      {
        price: dto.price,
        status: dto.status,
        surfaces: dto.surfaces,
        notes: dto.notes,
      },
      req.user.sub,
    );
  }

  @Delete('treatment-plans/:id/items/:itemId')
  @ApiOkResponse({ description: 'Item soft-deleted (deletedAt set)' })
  removeItem(@Param('itemId') itemId: string): Promise<void> {
    return this.removeTreatmentPlanItem.execute(itemId);
  }
}
