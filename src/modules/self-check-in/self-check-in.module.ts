import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { LocationsModule } from '../locations/locations.module';
import { MedicalHistoryModule } from '../medical-history/medical-history.module';
import { CheckInSettingsUseCases } from './application/check-in-settings.use-cases';
import { CheckInPendingService } from './application/check-in-pending.service';
import { CHECK_IN_REPOSITORY } from './domain/ports/check-in-repository.port';
import { PrismaCheckInRepository } from './infrastructure/prisma-check-in.repository';
import { CheckInSettingsController } from './presentation/check-in-settings.controller';

/**
 * DX-265: «Ya llegué», la parte sin dependencias de las citas: ajustes por
 * sede (solo ADMIN), el repositorio y el triaje de pendientes. Lo importan
 * AppointmentsModule (marca y pendientes en «En clínica») y
 * SelfCheckInPublicModule (las rutas públicas).
 */
@Module({
  imports: [JwtModule.register({}), LocationsModule, MedicalHistoryModule],
  controllers: [CheckInSettingsController],
  providers: [
    CheckInSettingsUseCases,
    CheckInPendingService,
    TokenService,
    TenantContextInterceptor,
    { provide: CHECK_IN_REPOSITORY, useClass: PrismaCheckInRepository },
  ],
  exports: [CHECK_IN_REPOSITORY, CheckInPendingService],
})
export class SelfCheckInModule {}
