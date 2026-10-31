import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { LocationsModule } from '../locations/locations.module';
import { StaffModule } from '../staff/staff.module';
import { ScheduleBlocksController } from './presentation/schedule-blocks.controller';
import {
  CreateScheduleBlockUseCase,
  DeleteScheduleBlockUseCase,
  ListAffectedAppointmentsUseCase,
  ListScheduleBlocksUseCase,
  UpdateScheduleBlockUseCase,
} from './application/use-cases/schedule-blocks.use-cases';
import { SCHEDULE_BLOCK_REPOSITORY } from './domain/ports/schedule-block-repository.port';
import { PrismaScheduleBlockRepository } from './infrastructure/repositories/prisma-schedule-block.repository';
import {
  SCHEDULE_BLOCK_CLOCK,
  systemScheduleBlockClock,
} from './application/schedule-block-clock';

/**
 * Bloqueos de agenda (DX-122). Exporta el repositorio para que la agenda
 * (AppointmentsModule) rechace o avise al agendar o mover encima de un
 * bloqueo, y para buscar huecos; y el reloj de los huecos reservados (DX-446).
 */
@Module({
  imports: [JwtModule.register({}), LocationsModule, StaffModule],
  controllers: [ScheduleBlocksController],
  providers: [
    ListScheduleBlocksUseCase,
    ListAffectedAppointmentsUseCase,
    CreateScheduleBlockUseCase,
    UpdateScheduleBlockUseCase,
    DeleteScheduleBlockUseCase,
    TokenService,
    TenantContextInterceptor,
    {
      provide: SCHEDULE_BLOCK_REPOSITORY,
      useClass: PrismaScheduleBlockRepository,
    },
    // DX-446: «¿ya se liberó el hueco reservado?»; los e2e lo fijan.
    { provide: SCHEDULE_BLOCK_CLOCK, useValue: systemScheduleBlockClock },
  ],
  exports: [SCHEDULE_BLOCK_REPOSITORY, SCHEDULE_BLOCK_CLOCK],
})
export class ScheduleBlocksModule {}
