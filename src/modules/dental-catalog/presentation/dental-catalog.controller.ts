import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CreateCatalogItemDto } from './dto/create-catalog-item.dto';
import { UpdateCatalogItemDto } from './dto/update-catalog-item.dto';
import { ListCatalogItemsQueryDto } from './dto/list-catalog-items-query.dto';
import { ListCatalogDirectoryQueryDto } from './dto/list-catalog-directory-query.dto';
import { CatalogDirectoryResponseDto } from './dto/catalog-directory-response.dto';
import { CreateCatalogItemUseCase } from '../application/use-cases/create-catalog-item.use-case';
import { ListCatalogItemsUseCase } from '../application/use-cases/list-catalog-items.use-case';
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
  list(@Query() query: ListCatalogItemsQueryDto): Promise<DentalCatalogItem[]> {
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
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCatalogItemDto,
  ): Promise<DentalCatalogItem> {
    return this.updateCatalogItem.execute(id, dto);
  }
}
