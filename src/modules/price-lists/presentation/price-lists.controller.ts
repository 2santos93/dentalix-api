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
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  PRICE_LIST_READ_ROLES,
  PRICE_LIST_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  CreatePriceListUseCase,
  DeletePriceListUseCase,
  ListPriceListItemsUseCase,
  type ListPriceListItemsOutput,
  ListPriceListsUseCase,
  ReplacePriceListItemsUseCase,
  UpdatePriceListUseCase,
} from '../application/use-cases/price-lists.use-cases';
import { PriceList } from '../domain/entities/price-list.entity';
import type { ReplacePriceListItemsResult } from '../domain/ports/price-list-repository.port';
import {
  CreatePriceListDto,
  ListPriceListItemsQueryDto,
  ListPriceListsQueryDto,
  PriceListDto,
  PriceListItemsPageDto,
  ReplacePriceListItemsDto,
  ReplacePriceListItemsResultDto,
  UpdatePriceListDto,
} from './dto/price-list.dto';

interface AuthenticatedRequest {
  user: JwtPayload;
}

// Listas de precios (DX-105). Leerlas: ADMIN, DENTIST y ASSISTANT (quien arma
// el plan). Crear, editar, retirar y cargar precios: solo ADMIN.
@ApiTags('price-lists')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PRICE_LIST_READ_ROLES)
@Controller('price-lists')
export class PriceListsController {
  constructor(
    private readonly listPriceLists: ListPriceListsUseCase,
    private readonly createPriceList: CreatePriceListUseCase,
    private readonly updatePriceList: UpdatePriceListUseCase,
    private readonly deletePriceList: DeletePriceListUseCase,
    private readonly listItems: ListPriceListItemsUseCase,
    private readonly replaceItems: ReplacePriceListItemsUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Listas de precios de la clínica (activas; con includeInactive, también las desactivadas)',
  })
  @ApiOkResponse({ type: [PriceListDto] })
  list(@Query() query: ListPriceListsQueryDto): Promise<PriceList[]> {
    return this.listPriceLists.execute({
      includeInactive: query.includeInactive,
    });
  }

  @Audit({
    action: 'CREATE',
    resource: 'PRICE_LIST',
    resourceId: { response: 'id' },
  })
  @Post()
  @Roles(...PRICE_LIST_WRITE_ROLES)
  @ApiOperation({ summary: 'Crear una lista de precios' })
  @ApiCreatedResponse({ type: PriceListDto })
  @ApiBadRequestResponse({
    description: 'Nombre fuera de 2–120 caracteres, moneda o sede inválidas',
  })
  @ApiConflictResponse({
    description:
      'Nombre duplicado, o la sede ya tiene una lista de precios activa',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  create(
    @Body() dto: CreatePriceListDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PriceList> {
    return this.createPriceList.execute(
      { name: dto.name, currency: dto.currency, locationId: dto.locationId },
      req.user.sub,
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'PRICE_LIST',
    resourceId: { param: 'id' },
  })
  @Patch(':id')
  @Roles(...PRICE_LIST_WRITE_ROLES)
  @ApiOperation({ summary: 'Editar o desactivar una lista de precios' })
  @ApiOkResponse({ type: PriceListDto })
  @ApiBadRequestResponse({ description: 'Campo inválido' })
  @ApiNotFoundResponse({
    description: 'Lista de precios no encontrada en esta clínica',
  })
  @ApiConflictResponse({
    description:
      'Nombre duplicado, sede con otra lista activa o moneda bloqueada por tener precios',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePriceListDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PriceList> {
    return this.updatePriceList.execute(
      id,
      {
        name: dto.name,
        currency: dto.currency,
        locationId: dto.locationId,
        active: dto.active,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'DELETE',
    resource: 'PRICE_LIST',
    resourceId: { param: 'id' },
  })
  @Delete(':id')
  @HttpCode(204)
  @Roles(...PRICE_LIST_WRITE_ROLES)
  @ApiOperation({
    summary: 'Retirar una lista de precios sin convenios (borrado lógico)',
  })
  @ApiNoContentResponse({ description: 'Retirada (borrado lógico).' })
  @ApiNotFoundResponse({
    description: 'Lista de precios no encontrada en esta clínica',
  })
  @ApiConflictResponse({
    description: 'La usa un convenio vivo; se desactiva en lugar de retirarla',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.deletePriceList.execute(id, req.user.sub);
  }

  @Get(':id/items')
  @ApiOperation({
    summary:
      'Procedimientos activos del catálogo con su precio en la lista (o null), paginados',
  })
  @ApiOkResponse({ type: PriceListItemsPageDto })
  @ApiNotFoundResponse({
    description: 'Lista de precios no encontrada en esta clínica',
  })
  items(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListPriceListItemsQueryDto,
  ): Promise<ListPriceListItemsOutput> {
    return this.listItems.execute(id, {
      query: query.query,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Audit({
    action: 'UPDATE',
    resource: 'PRICE_LIST',
    resourceId: { param: 'id' },
    reason: 'PRICES_REPLACED',
  })
  @Put(':id/items')
  @Roles(...PRICE_LIST_WRITE_ROLES)
  @ApiOperation({
    summary:
      'Fijar o quitar (price: null) los precios de hasta 500 procedimientos, en una transacción',
  })
  @ApiOkResponse({ type: ReplacePriceListItemsResultDto })
  @ApiBadRequestResponse({
    description:
      'Precio inválido, prestación repetida o que no es del catálogo de esta clínica (no se escribe nada)',
  })
  @ApiNotFoundResponse({
    description: 'Lista de precios no encontrada en esta clínica',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  replace(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplacePriceListItemsDto,
  ): Promise<ReplacePriceListItemsResult> {
    return this.replaceItems.execute(
      id,
      dto.items.map((i) => ({
        catalogItemId: i.catalogItemId,
        price: i.price,
      })),
    );
  }
}
