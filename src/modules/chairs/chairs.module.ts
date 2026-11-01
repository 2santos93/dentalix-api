import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { LocationsModule } from '../locations/locations.module';
import { StaffModule } from '../staff/staff.module';
import { ChairsController } from './presentation/chairs.controller';
import {
  CreateChairUseCase,
  ListChairsUseCase,
  ReorderChairsUseCase,
  SetChairActiveUseCase,
  UpdateChairUseCase,
} from './application/use-cases/chairs.use-cases';
import { CHAIR_REPOSITORY } from './domain/ports/chair-repository.port';
import { PrismaChairRepository } from './infrastructure/repositories/prisma-chair.repository';

/**
 * Sillones de cada sede (DX-211). Exporta el repositorio para que
 * AppointmentsModule resuelva «¿este sillón es de ESTA clínica, de la sede de
 * la cita y está activo?» al agendar o mover, sin re-implementarlo.
 */
@Module({
  imports: [JwtModule.register({}), LocationsModule, StaffModule],
  controllers: [ChairsController],
  providers: [
    ListChairsUseCase,
    CreateChairUseCase,
    UpdateChairUseCase,
    SetChairActiveUseCase,
    ReorderChairsUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: CHAIR_REPOSITORY, useClass: PrismaChairRepository },
  ],
  exports: [CHAIR_REPOSITORY],
})
export class ChairsModule {}
