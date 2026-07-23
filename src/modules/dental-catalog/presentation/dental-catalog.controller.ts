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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CreateCatalogItemDto } from './dto/create-catalog-item.dto';
import { UpdateCatalogItemDto } from './dto/update-catalog-item.dto';
import { ListCatalogItemsQueryDto } from './dto/list-catalog-items-query.dto';
import { CreateCatalogItemUseCase } from '../application/use-cases/create-catalog-item.use-case';
import { ListCatalogItemsUseCase } from '../application/use-cases/list-catalog-items.use-case';
import { UpdateCatalogItemUseCase } from '../application/use-cases/update-catalog-item.use-case';
import { DentalCatalogItem } from '../domain/entities/dental-catalog-item.entity';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  CATALOG_READ_ROLES,
  CATALOG_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';

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
    private readonly updateCatalogItem: UpdateCatalogItemUseCase,
  ) {}

  @Post()
  @Roles(...CATALOG_WRITE_ROLES)
  create(@Body() dto: CreateCatalogItemDto): Promise<DentalCatalogItem> {
    return this.createCatalogItem.execute(dto);
  }

  @Get()
  list(@Query() query: ListCatalogItemsQueryDto): Promise<DentalCatalogItem[]> {
    return this.listCatalogItems.execute({
      kind: query.kind,
      activeOnly: query.activeOnly,
    });
  }

  @Patch(':id')
  @Roles(...CATALOG_WRITE_ROLES)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCatalogItemDto,
  ): Promise<DentalCatalogItem> {
    return this.updateCatalogItem.execute(id, dto);
  }
}
