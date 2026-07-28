import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './presentation/auth.controller';
import { RegisterClinicUseCase } from './application/use-cases/register-clinic.use-case';
import { LoginUseCase } from './application/use-cases/login.use-case';
import { RefreshUseCase } from './application/use-cases/refresh.use-case';
import { LogoutUseCase } from './application/use-cases/logout.use-case';
import { AUTH_REPOSITORY } from './domain/ports/auth-repository.port';
import { PrismaAuthRepository } from './infrastructure/repositories/prisma-auth.repository';
import { PasswordService } from '../../shared/crypto/password.service';
import { TokenService } from '../../shared/crypto/token.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    RegisterClinicUseCase,
    LoginUseCase,
    RefreshUseCase,
    LogoutUseCase,
    PasswordService,
    TokenService,
    { provide: AUTH_REPOSITORY, useClass: PrismaAuthRepository },
  ],
})
export class AuthModule {}
