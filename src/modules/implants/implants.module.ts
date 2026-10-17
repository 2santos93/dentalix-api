import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import {
  GetImplantCardUseCase,
  IMPLANT_CLOCK,
  ImplantCatalogUseCase,
  ListPatientImplantsUseCase,
  RegisterImplantUseCase,
  SearchImplantsByLotUseCase,
  VoidImplantUseCase,
} from './application/use-cases/implants.use-cases';
import { PATIENT_IMPLANT_REPOSITORY } from './domain/ports/patient-implant-repository.port';
import { PrismaPatientImplantRepository } from './infrastructure/prisma-patient-implant.repository';
import {
  ImplantsController,
  PatientImplantsController,
} from './presentation/implants.controller';

/**
 * Registro de implantes (DX-191): ficha inalterable de cada componente
 * colocado (anulación con motivo), tarjeta de implante imprimible con fecha de
 * entrega, autocompletar de fabricantes y búsqueda por lote/REF (solo ADMIN).
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [PatientImplantsController, ImplantsController],
  providers: [
    RegisterImplantUseCase,
    ListPatientImplantsUseCase,
    VoidImplantUseCase,
    GetImplantCardUseCase,
    ImplantCatalogUseCase,
    SearchImplantsByLotUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: IMPLANT_CLOCK, useValue: () => new Date() },
    {
      provide: PATIENT_IMPLANT_REPOSITORY,
      useClass: PrismaPatientImplantRepository,
    },
  ],
})
export class ImplantsModule {}
