import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { REFERENCE_REPOSITORY } from './domain/ports/reference-repository.port';
import { PrismaReferenceRepository } from './infrastructure/repositories/prisma-reference.repository';
import { ListCurrenciesUseCase } from './application/use-cases/list-currencies.use-case';
import { ListCountriesUseCase } from './application/use-cases/list-countries.use-case';
import { ReferenceController } from './presentation/reference.controller';
import { TokenService } from '../../shared/crypto/token.service';

@Module({
  // JwtModule.register({}) mirrors ExchangeModule/PatientsModule/StaffModule:
  // JwtAuthGuard depends on TokenService, which depends on JwtService — must
  // be available here since the guard is applied on this module's controller.
  imports: [JwtModule.register({})],
  controllers: [ReferenceController],
  providers: [
    ListCurrenciesUseCase,
    ListCountriesUseCase,
    TokenService,
    { provide: REFERENCE_REPOSITORY, useClass: PrismaReferenceRepository },
  ],
})
export class ReferenceModule {}
