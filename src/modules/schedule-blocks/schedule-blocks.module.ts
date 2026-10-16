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

/**
 * Bloqueos de agenda (DX-122). Exporta el repositorio para que la agenda
 * (AppointmentsModule) rechace o avise al agendar o mover encima de un
 * bloqueo, y para buscar huecos.
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
  ],
  exports: [SCHEDULE_BLOCK_REPOSITORY],
})
export class ScheduleBlocksModule {}
