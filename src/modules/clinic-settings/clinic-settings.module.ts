import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { StorageModule } from '../../shared/storage/storage.module';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import {
  GetClinicSettingsUseCase,
  RemoveClinicLogoUseCase,
  SetClinicLogoUseCase,
  UpdateClinicSettingsUseCase,
} from './application/clinic-settings.use-cases';
import { CLINIC_SETTINGS_REPOSITORY } from './domain/ports/clinic-settings-repository.port';
import { PrismaClinicSettingsRepository } from './infrastructure/prisma-clinic-settings.repository';
import { ClinicSettingsController } from './presentation/clinic-settings.controller';

/** DX-019: Ajustes › Datos de la clínica. */
@Module({
  imports: [JwtModule.register({}), StorageModule],
  controllers: [ClinicSettingsController],
  providers: [
    GetClinicSettingsUseCase,
    UpdateClinicSettingsUseCase,
    SetClinicLogoUseCase,
    RemoveClinicLogoUseCase,
    TokenService,
    TenantContextInterceptor,
    {
      provide: CLINIC_SETTINGS_REPOSITORY,
      useClass: PrismaClinicSettingsRepository,
    },
  ],
})
export class ClinicSettingsModule {}
