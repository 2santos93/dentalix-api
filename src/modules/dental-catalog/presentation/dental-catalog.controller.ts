import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CreateCatalogItemDto } from './dto/create-catalog-item.dto';
import { UpdateCatalogItemDto } from './dto/update-catalog-item.dto';
import { ListCatalogItemsQueryDto } from './dto/list-catalog-items-query.dto';
import { ListCatalogDirectoryQueryDto } from './dto/list-catalog-directory-query.dto';
import { CatalogDirectoryResponseDto } from './dto/catalog-directory-response.dto';
import { CreateCatalogItemUseCase } from '../application/use-cases/create-catalog-item.use-case';
import {
  ListCatalogItemsUseCase,
  type CatalogItemWithCurrency,
} from '../application/use-cases/list-catalog-items.use-case';
import {
  ListCatalogDirectoryUseCase,
  type ListCatalogDirectoryOutput,
} from '../application/use-cases/list-catalog-directory.use-case';
import { UpdateCatalogItemUseCase } from '../application/use-cases/update-catalog-item.use-case';
import { DentalCatalogItem } from '../domain/entities/dental-catalog-item.entity';
import { DentalCatalogItemDto } from './dto/dental-catalog-item.dto';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  CATALOG_READ_ROLES,
  CATALOG_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import type { JwtPayload } from '../../../shared/crypto/token.service';
import { GetCatalogPriceHistoryUseCase } from '../application/use-cases/catalog-price-change.use-cases';
import { CatalogPriceHistoryEntryDto } from './dto/catalog-price-change.dto';

interface AuthenticatedRequest {
  user: JwtPayload;
}

@ApiTags('catalog')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CATALOG_READ_ROLES)
@Controller('catalog/items')
export class DentalCatalogController {
  constructor(
    private readonly createCatalogItem: CreateCatalogItemUseCase,
    private readonly listCatalogItems: ListCatalogItemsUseCase,
    private readonly listCatalogDirectory: ListCatalogDirectoryUseCase,
    private readonly updateCatalogItem: UpdateCatalogItemUseCase,
    private readonly priceHistory: GetCatalogPriceHistoryUseCase,
  ) {}

  // DX-212: altas y cambios del catálogo quedan auditados (campos cambiados,
  // nunca valores).
  @Audit({
    action: 'CREATE',
    resource: 'DENTAL_CATALOG_ITEM',
    resourceId: { response: 'id' },
  })
  @Post()
  @Roles(...CATALOG_WRITE_ROLES)
  @ApiCreatedResponse({ type: DentalCatalogItemDto })
  create(@Body() dto: CreateCatalogItemDto): Promise<DentalCatalogItem> {
    return this.createCatalogItem.execute(dto);
  }

  @Get()
  @ApiOkResponse({ type: [DentalCatalogItemDto] })
  list(
    @Query() query: ListCatalogItemsQueryDto,
  ): Promise<CatalogItemWithCurrency[]> {
    return this.listCatalogItems.execute({
      kind: query.kind,
      activeOnly: query.activeOnly,
    });
  }

  /**
   * La lista paginada y buscable que consume la pantalla de gestión.
   *
   * Va aparte de `GET /catalog/items` —que devuelve el catálogo entero— por la
   * misma razón que `GET /staff/directory` convive con `GET /staff`: los
   * selectores del odontograma y del plan de tratamiento necesitan todas las
   * opciones, y una tabla de administración necesita una página. Un solo
   * endpoint obligaría a uno de los dos a fingir.
   */
  @Get('directory')
  @ApiOkResponse({ type: CatalogDirectoryResponseDto })
  listDirectory(
    @Query() query: ListCatalogDirectoryQueryDto,
  ): Promise<ListCatalogDirectoryOutput> {
    return this.listCatalogDirectory.execute({
      query: query.query,
      kind: query.kind,
      activeOnly: query.activeOnly,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Audit({
    action: 'UPDATE',
    resource: 'DENTAL_CATALOG_ITEM',
    resourceId: { param: 'id' },
  })
  @Patch(':id')
  @Roles(...CATALOG_WRITE_ROLES)
  @ApiOkResponse({ type: DentalCatalogItemDto })
  @ApiBadRequestResponse({ description: 'Id que no es UUID' })
  @ApiParam({ name: 'id', format: 'uuid' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCatalogItemDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<DentalCatalogItem> {
    // DX-205: quien edita queda como autor en el historial de precios.
    return this.updateCatalogItem.execute(id, dto, req.user.sub);
  }

  // DX-205: «Historial de precios» del ítem. Solo ADMIN, como «Actualizar
  // precios»: los demás roles reciben 403 y la pantalla no muestra la pestaña.
  @Get(':id/price-history')
  @Roles(...CATALOG_WRITE_ROLES)
  @ApiOperation({
    summary: 'Historial del precio por defecto de un ítem del catálogo',
    description:
      'Cada cambio (edición suelta o lote de «Actualizar precios») con el precio anterior, el nuevo, el lote, el autor y la fecha, del más reciente al más antiguo (como mucho 200).',
  })
  @ApiOkResponse({ type: [CatalogPriceHistoryEntryDto] })
  @ApiBadRequestResponse({ description: 'Id que no es UUID' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  @ApiNotFoundResponse({
    description: 'El ítem no existe en el catálogo de esta clínica',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  async listPriceHistory(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CatalogPriceHistoryEntryDto[]> {
    const entries = await this.priceHistory.execute(id);
    return entries.map((entry) => ({
      id: entry.id,
      previousPrice: entry.previousPrice?.toNumber() ?? null,
      newPrice: entry.newPrice?.toNumber() ?? null,
      batchId: entry.batchId,
      actorUserId: entry.actorUserId,
      actorName: entry.actorName,
      createdAt: entry.createdAt.toISOString(),
    }));
  }
}
