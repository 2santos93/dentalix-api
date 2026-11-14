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
import { LOGO_IMAGE_CODEC } from './domain/ports/logo-image-codec.port';
import { PrismaClinicSettingsRepository } from './infrastructure/prisma-clinic-settings.repository';
import { SharpLogoImageCodec } from './infrastructure/sharp-logo-image-codec';
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
    { provide: LOGO_IMAGE_CODEC, useClass: SharpLogoImageCodec },
  ],
})
export class ClinicSettingsModule {}
