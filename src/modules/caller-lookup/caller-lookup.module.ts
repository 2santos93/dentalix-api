import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { CollectionsModule } from '../collections/collections.module';
import { MedicalHistoryModule } from '../medical-history/medical-history.module';
import { CALLER_LOOKUP_CLOCK } from './application/caller-lookup-clock';
import { CallerLookupUseCase } from './application/caller-lookup.use-case';
import { CALLER_LOOKUP_REPOSITORY } from './domain/caller-lookup-repository.port';
import { PrismaCallerLookupRepository } from './infrastructure/prisma-caller-lookup.repository';
import { CallerLookupController } from './presentation/caller-lookup.controller';

/**
 * DX-224: «¿Quién llama?». Módulo propio y no dentro de PatientsModule:
 * MedicalHistoryModule ya importa PatientsModule, así que PatientsModule no
 * puede importar las banderas médicas (ciclo).
 */
@Module({
  // JwtModule.register({}): JwtAuthGuard depende de TokenService (como PatientsModule).
  imports: [JwtModule.register({}), CollectionsModule, MedicalHistoryModule],
  controllers: [CallerLookupController],
  providers: [
    CallerLookupUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: CALLER_LOOKUP_CLOCK, useValue: () => new Date() },
    {
      provide: CALLER_LOOKUP_REPOSITORY,
      useClass: PrismaCallerLookupRepository,
    },
  ],
})
export class CallerLookupModule {}
