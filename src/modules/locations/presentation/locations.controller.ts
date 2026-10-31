import {
  Body,
  Controller,
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
  ApiOperation,
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
import { Audit } from '../../audit/presentation/audit.decorator';
import type { AuditedRequest } from '../../audit/presentation/audit-request';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  withPhoneInternational,
  type WithPhoneInternational,
} from '../../../shared/phone/with-phone-international';

type LocationOutput = WithPhoneInternational<Location>;

/**
 * DX-387: el teléfono de cada sede se lee con SU región por defecto, que ya
 * viene en la fila: ninguna consulta más.
 */
const present = (location: Location): LocationOutput =>
  withPhoneInternational(location, location.defaultPhoneRegion);

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
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOkResponse({ type: [LocationDto] })
  async list(): Promise<LocationOutput[]> {
    return (await this.listLocations.execute()).map(present);
  }

  // DX-360: auditado en la transacción del alta (CREATE LOCATION,
  // LOCATION_CREATED) con nombre, país, valores regionales y teléfono.
  @Post()
  @Roles(ClinicRole.ADMIN)
  @ApiOperation({
    summary: 'Crea una sede',
    description:
      'Queda en la auditoría (LOCATION_CREATED) con su nombre, país, moneda, zona, formato, reloj, teléfono y región telefónica por defecto (defaultPhoneRegion); nunca la dirección.',
  })
  @ApiCreatedResponse({ type: LocationDto })
  async create(
    @Body() dto: CreateLocationDto,
    @Req() req: AuditableRequest,
  ): Promise<LocationOutput> {
    return present(
      await this.createLocation.execute(
        dto,
        requireAuditRequestContext(req, this.tenantContext),
      ),
    );
  }

  // Los cambios de la sede quedan auditados (campos cambiados, nunca sus
  // valores). DX-319: el nº de registro sanitario y si se imprime, además,
  // con su antes y después (es un dato de la sede, no de un paciente).
  @Audit({
    action: 'UPDATE',
    resource: 'LOCATION',
    resourceId: { param: 'id' },
  })
  @Patch(':id')
  @Roles(ClinicRole.ADMIN)
  @ApiOkResponse({ type: LocationDto })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateLocationDto,
    @Req() req: AuditedRequest,
  ): Promise<LocationOutput> {
    const { location, healthRegistration, regionalSettings } =
      await this.updateLocation.execute(id, dto);
    if (healthRegistration || regionalSettings) {
      req.auditMetadata = {
        ...(healthRegistration ? { healthRegistration } : {}),
        ...(regionalSettings ? { regionalSettings } : {}),
      };
    }
    return present(location);
  }
}
