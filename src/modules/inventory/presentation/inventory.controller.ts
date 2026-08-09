import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
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
import { CreateInventoryItemDto } from './dto/create-inventory-item.dto';
import { UpdateInventoryItemDto } from './dto/update-inventory-item.dto';
import { RecordInventoryMovementDto } from './dto/record-inventory-movement.dto';
import { ListInventoryItemsQueryDto } from './dto/list-inventory-items-query.dto';
import { ListInventoryItemsResponseDto } from './dto/list-inventory-items-response.dto';
import { InventoryItemDto } from './dto/inventory-item.dto';
import { InventoryMovementDto } from './dto/inventory-movement.dto';
import { CreateInventoryItemUseCase } from '../application/use-cases/create-inventory-item.use-case';
import {
  ListInventoryItemsUseCase,
  ListInventoryItemsOutput,
} from '../application/use-cases/list-inventory-items.use-case';
import { GetInventoryItemUseCase } from '../application/use-cases/get-inventory-item.use-case';
import { UpdateInventoryItemUseCase } from '../application/use-cases/update-inventory-item.use-case';
import { DeleteInventoryItemUseCase } from '../application/use-cases/delete-inventory-item.use-case';
import { RecordInventoryMovementUseCase } from '../application/use-cases/record-inventory-movement.use-case';
import {
  InventoryItem,
  InventoryItemDetail,
} from '../domain/entities/inventory-item.entity';
import { InventoryMovement } from '../domain/entities/inventory-movement.entity';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { INVENTORY_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';

interface AuthenticatedRequest {
  user: JwtPayload;
}

// Inventario es gestión de insumos + admin -> @Roles(...INVENTORY_ROLES)
// (ADMIN/ASSISTANT; RECEPTION/DENTIST NO -- ver
// docs/plans/2026-07-24-inventory.md "Global Constraints"). Single
// `@Controller('inventory/items')` prefix covers every route below (unlike
// TreatmentPlansController, which mixes two different prefixes) --
// `:id`/`:id/movements` never collide since Express matches by segment
// count, so route registration order does not matter here.
@ApiTags('inventory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...INVENTORY_ROLES)
@Controller('inventory/items')
export class InventoryController {
  constructor(
    private readonly createInventoryItem: CreateInventoryItemUseCase,
    private readonly listInventoryItems: ListInventoryItemsUseCase,
    private readonly getInventoryItem: GetInventoryItemUseCase,
    private readonly updateInventoryItem: UpdateInventoryItemUseCase,
    private readonly deleteInventoryItem: DeleteInventoryItemUseCase,
    private readonly recordInventoryMovement: RecordInventoryMovementUseCase,
  ) {}

  @Post()
  @ApiCreatedResponse({ type: InventoryItemDto })
  create(
    @Body() dto: CreateInventoryItemDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<InventoryItem> {
    // `createdById` comes from the authenticated user (req.user.sub), never
    // from the client body -- same convention as
    // SalesController.create / TreatmentPlansController.create.
    return this.createInventoryItem.execute(
      {
        name: dto.name,
        sku: dto.sku,
        unit: dto.unit,
        minStock: dto.minStock,
        notes: dto.notes,
      },
      req.user.sub,
    );
  }

  @Get()
  @ApiOkResponse({ type: ListInventoryItemsResponseDto })
  list(
    @Query() query: ListInventoryItemsQueryDto,
  ): Promise<ListInventoryItemsOutput> {
    return this.listInventoryItems.execute({
      query: query.query,
      page: query.page,
      pageSize: query.pageSize,
      lowStockOnly: query.lowStockOnly,
    });
  }

  @Get(':id')
  @ApiOkResponse({ type: InventoryItemDto })
  get(@Param('id') id: string): Promise<InventoryItemDetail> {
    return this.getInventoryItem.execute(id);
  }

  @Patch(':id')
  @ApiOkResponse({ type: InventoryItemDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateInventoryItemDto,
  ): Promise<InventoryItem> {
    return this.updateInventoryItem.execute(id, {
      name: dto.name,
      sku: dto.sku,
      unit: dto.unit,
      minStock: dto.minStock,
      notes: dto.notes,
    });
  }

  @Delete(':id')
  @ApiOkResponse({ description: 'Item soft-deleted (deletedAt set)' })
  remove(@Param('id') id: string): Promise<void> {
    return this.deleteInventoryItem.execute(id);
  }

  @Post(':id/movements')
  @ApiCreatedResponse({ type: InventoryMovementDto })
  createMovement(
    @Param('id') id: string,
    @Body() dto: RecordInventoryMovementDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<InventoryMovement> {
    // `itemId` comes from the route param (never duplicated in the body);
    // `createdById` from the authenticated user -- same convention as
    // `create` above.
    return this.recordInventoryMovement.execute(
      {
        itemId: id,
        type: dto.type,
        quantity: dto.quantity,
        reason: dto.reason,
      },
      req.user.sub,
    );
  }

  @Get(':id/movements')
  @ApiOkResponse({ type: [InventoryMovementDto] })
  async listMovements(@Param('id') id: string): Promise<InventoryMovement[]> {
    // Reuses GetInventoryItemUseCase (the only use case that already loads
    // an item's movements) instead of reaching into the repository
    // directly from the controller -- keeps the DTO -> Resolver/Controller
    // -> Service -> Repository flow intact and gets the same NotFound (item
    // missing/soft-deleted/cross-tenant) handling for free, same rationale
    // as GetSaleUseCase/GetTreatmentPlanUseCase.
    const detail = await this.getInventoryItem.execute(id);
    return detail.movements;
  }
}
