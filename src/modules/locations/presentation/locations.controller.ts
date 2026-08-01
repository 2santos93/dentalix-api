import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import {
  CreateLocationDto,
  LocationDto,
  UpdateLocationDto,
} from './dto/location.dto';
import {
  CreateLocationUseCase,
  ListLocationsUseCase,
  UpdateLocationUseCase,
} from '../application/use-cases/manage-locations.use-cases';
import type { Location } from '../domain/ports/location-repository.port';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { PATIENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';

/**
 * Sedes de la clínica. LEER lo puede todo el mundo (cualquier rol necesita
 * saber en qué sede está trabajando), pero CREAR/EDITAR es solo de gestión
 * (ADMIN) — misma lógica que el catálogo.
 */
@ApiTags('locations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PATIENT_ROLES)
@Controller('locations')
export class LocationsController {
  constructor(
    private readonly listLocations: ListLocationsUseCase,
    private readonly createLocation: CreateLocationUseCase,
    private readonly updateLocation: UpdateLocationUseCase,
  ) {}

  @Get()
  @ApiOkResponse({ type: [LocationDto] })
  list(): Promise<Location[]> {
    return this.listLocations.execute();
  }

  @Post()
  @Roles(ClinicRole.ADMIN)
  @ApiCreatedResponse({ type: LocationDto })
  create(@Body() dto: CreateLocationDto): Promise<Location> {
    return this.createLocation.execute(dto);
  }

  @Patch(':id')
  @Roles(ClinicRole.ADMIN)
  @ApiOkResponse({ type: LocationDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateLocationDto,
  ): Promise<Location> {
    return this.updateLocation.execute(id, dto);
  }
}
