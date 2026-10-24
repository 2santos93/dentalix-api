import {
  Body,
  Controller,
  Get,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { ROUTE_ACCESS, RouteAccess } from '../test/support/route-access-matrix';
import {
  collectControllers,
  discoverRoutes,
} from '../test/support/route-discovery';
import {
  ID_INPUTS_COVERED_ELSEWHERE,
  ID_INPUTS_IN_MATRIX,
  idInputCoverageGaps,
  tenantIdInputs,
} from '../test/support/tenant-id-inputs';
import { uuidInputsOf } from '../test/support/uuid-inputs';
import { AppModule } from './app.module';
import { JwtAuthGuard } from './modules/auth/presentation/guards/jwt-auth.guard';
import { Roles } from './modules/auth/presentation/guards/roles.decorator';
import { RolesGuard } from './modules/auth/presentation/guards/roles.guard';
import { TenantContextInterceptor } from './shared/tenancy/tenant-context.interceptor';

// Mismo motivo que en auth-matrix.spec.ts: el ConfigModule real valida el
// entorno al importarse y el job `checks` no lo tiene.
jest.mock('./config/config.module', () => ({
  ConfigModule: class ConfigModule {},
}));

/**
 * DX-207 (TST-022): cada id de recurso que una ruta de clínica recibe por la
 * query o el cuerpo (`@IsUUID`, también en listas `each: true` y en DTO
 * anidados) tiene su caso de aislamiento en la matriz e2e o una exención que
 * cita su spec (`test/support/tenant-id-inputs.ts`).
 */

// --- Fixture del test de control: una ruta de clínica con ids nuevos ---------

class FakeLineDto {
  @IsUUID()
  lineItemId!: string;
}

class FakeBodyDto {
  @IsUUID()
  otherClinicId!: string;

  @IsOptional()
  @IsUUID('4', { each: true })
  relatedIds?: string[];

  @ValidateNested({ each: true })
  @Type(() => FakeLineDto)
  lines!: FakeLineDto[];

  @IsString()
  note!: string;
}

class FakeQueryDto {
  @IsOptional()
  @IsUUID()
  ownerId?: string;
}

@Controller('fake-isolation')
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(ClinicRole.ADMIN)
class FakeIsolationController {
  @Post()
  create(@Body() body: FakeBodyDto): FakeBodyDto {
    return body;
  }

  @Get()
  list(
    @Query() query: FakeQueryDto,
    @Query('sedeId', ParseUUIDPipe) sedeId: string,
  ): string[] {
    return [query.ownerId ?? '', sedeId];
  }
}

describe('Ids de recurso por query y cuerpo (DX-207, TST-022)', () => {
  const routes = discoverRoutes(collectControllers(AppModule));
  const discovered = tenantIdInputs(routes, ROUTE_ACCESS);

  it('descubre los ids de verdad (no una lista vacía)', () => {
    expect(discovered.length).toBeGreaterThan(80);
    // Los filtros de agenda, pendientes y cartera que motivaron TST-022.
    expect(discovered).toEqual(
      expect.arrayContaining([
        'GET /appointments ?providerIds[]',
        'GET /appointments/openings ?providerId',
        'GET /schedule-blocks/affected-appointments ?providerId',
        'GET /schedule-blocks/affected-appointments ?locationId',
        'GET /waitlist ?locationId',
        'POST /appointments body.patientId',
        'POST /waitlist body.appointmentTypeId',
        'POST /schedule-blocks body.locationId',
        'PUT /price-lists/:id/items body.items[].catalogItemId',
      ]),
    );
  });

  it('cada id por query/cuerpo de una ruta de clínica tiene caso o exención, y ninguna entrada sobra', () => {
    expect(idInputCoverageGaps(discovered)).toEqual({
      sinCaso: [],
      entradaSinId: [],
      duplicada: [],
    });
  });

  it('cada exención cita un spec e2e que existe', () => {
    const missing = Object.entries(ID_INPUTS_COVERED_ELSEWHERE)
      .filter(
        ([, spec]) =>
          !spec.endsWith('.e2e-spec.ts') ||
          !existsSync(path.join(__dirname, '..', 'test', spec)),
      )
      .map(([id, spec]) => `${id} → ${spec}`);
    expect(missing).toEqual([]);
  });

  it('control: un DTO falso con ids nuevos sin caso hace fallar la invariante con la ruta y el campo', () => {
    const fake = discoverRoutes([FakeIsolationController]);
    const access: Record<string, RouteAccess> = {
      ...ROUTE_ACCESS,
      'POST /fake-isolation': { kind: 'roles', roles: [ClinicRole.ADMIN] },
      'GET /fake-isolation': { kind: 'roles', roles: [ClinicRole.ADMIN] },
    };
    expect(uuidInputsOf(FakeIsolationController, 'create')).toEqual([
      'body.lines[].lineItemId',
      'body.otherClinicId',
      'body.relatedIds[]',
    ]);
    const gaps = idInputCoverageGaps([
      ...discovered,
      ...tenantIdInputs(fake, access),
    ]);
    expect(gaps.sinCaso).toEqual([
      'GET /fake-isolation ?ownerId',
      'GET /fake-isolation ?sedeId',
      'POST /fake-isolation body.lines[].lineItemId',
      'POST /fake-isolation body.otherClinicId',
      'POST /fake-isolation body.relatedIds[]',
    ]);
    // Con su caso en la matriz, deja de fallar.
    expect(
      idInputCoverageGaps(
        [...discovered, 'POST /fake-isolation body.otherClinicId'],
        [...ID_INPUTS_IN_MATRIX, 'POST /fake-isolation body.otherClinicId'],
      ).sinCaso,
    ).toEqual([]);
  });

  it('control: una ruta pública o de plataforma no entra (no hay clínica que aislar)', () => {
    const fake = discoverRoutes([FakeIsolationController]);
    const access: Record<string, RouteAccess> = {
      'POST /fake-isolation': { kind: 'public', tenantScoped: true },
      'GET /fake-isolation': { kind: 'platform' },
    };
    expect(tenantIdInputs(fake, access)).toEqual([]);
  });
});
