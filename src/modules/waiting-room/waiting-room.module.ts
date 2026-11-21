import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { LocationsModule } from '../locations/locations.module';
import {
  PublicWaitingRoomUseCases,
  WAITING_ROOM_CLOCK,
} from './application/public-waiting-room.use-cases';
import { WaitingRoomScreensUseCases } from './application/waiting-room-screens.use-cases';
import { WAITING_ROOM_REPOSITORY } from './domain/ports/waiting-room-repository.port';
import { PrismaWaitingRoomRepository } from './infrastructure/prisma-waiting-room.repository';
import { PublicWaitingRoomController } from './presentation/public-waiting-room.controller';
import { WaitingRoomScreensController } from './presentation/waiting-room-screens.controller';

/**
 * DX-588: pantalla de sala de espera (el televisor). Ajustes (solo ADMIN) y
 * el tablero público de solo lectura por token. El turno del día lo da
 * AppointmentsModule al marcar «Llegó» (`assignTurnNumber`).
 */
@Module({
  imports: [JwtModule.register({}), LocationsModule],
  controllers: [WaitingRoomScreensController, PublicWaitingRoomController],
  providers: [
    WaitingRoomScreensUseCases,
    PublicWaitingRoomUseCases,
    TokenService,
    TenantContextInterceptor,
    { provide: WAITING_ROOM_REPOSITORY, useClass: PrismaWaitingRoomRepository },
    { provide: WAITING_ROOM_CLOCK, useValue: () => new Date() },
  ],
})
export class WaitingRoomModule {}
