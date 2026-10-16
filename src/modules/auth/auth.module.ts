import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './presentation/auth.controller';
import { SessionCookieService } from './presentation/session-cookie.service';
import { RegisterClinicUseCase } from './application/use-cases/register-clinic.use-case';
import { LoginUseCase } from './application/use-cases/login.use-case';
import { RefreshUseCase } from './application/use-cases/refresh.use-case';
import { LogoutUseCase } from './application/use-cases/logout.use-case';
import { SessionClaimsService } from './application/session-claims.service';
import { AUTH_REPOSITORY } from './domain/ports/auth-repository.port';
import { PrismaAuthRepository } from './infrastructure/repositories/prisma-auth.repository';
import { PasswordService } from '../../shared/crypto/password.service';
import { TokenService } from '../../shared/crypto/token.service';
import { EmailModule } from '../notifications/email/email.module';
import { PasswordResetController } from './presentation/password-reset.controller';
import { RequestPasswordResetUseCase } from './application/use-cases/request-password-reset.use-case';
import { ResetPasswordUseCase } from './application/use-cases/reset-password.use-case';
import { PASSWORD_RESET_REPOSITORY } from './domain/ports/password-reset-repository.port';
import { PASSWORD_RESET_NOTIFIER } from './domain/ports/password-reset-notifier.port';
import { PrismaPasswordResetRepository } from './infrastructure/repositories/prisma-password-reset.repository';
import { EmailPasswordResetNotifier } from './infrastructure/email-password-reset.notifier';
import { REGISTRATION_REPOSITORY } from './domain/ports/registration-repository.port';
import { REGISTRATION_NOTIFIER } from './domain/ports/registration-notifier.port';
import { PrismaRegistrationRepository } from './infrastructure/repositories/prisma-registration.repository';
import { EmailRegistrationNotifier } from './infrastructure/email-registration.notifier';

@Module({
  imports: [JwtModule.register({}), EmailModule],
  controllers: [AuthController, PasswordResetController],
  providers: [
    RegisterClinicUseCase,
    LoginUseCase,
    RefreshUseCase,
    LogoutUseCase,
    SessionClaimsService,
    SessionCookieService,
    PasswordService,
    TokenService,
    { provide: AUTH_REPOSITORY, useClass: PrismaAuthRepository },
    // Registro con verificación del email (DX-029).
    {
      provide: REGISTRATION_REPOSITORY,
      useClass: PrismaRegistrationRepository,
    },
    { provide: REGISTRATION_NOTIFIER, useClass: EmailRegistrationNotifier },
    // Recuperar la contraseña por email (DX-010).
    RequestPasswordResetUseCase,
    ResetPasswordUseCase,
    {
      provide: PASSWORD_RESET_REPOSITORY,
      useClass: PrismaPasswordResetRepository,
    },
    { provide: PASSWORD_RESET_NOTIFIER, useClass: EmailPasswordResetNotifier },
  ],
  // El cambio de contraseña (MeModule) vuelve a emitir el par de la sesión
  // con los claims ACTUALES, igual que /auth/refresh. Él y aceptar invitación
  // (InvitationsModule) entregan el par con la cookie de sesión (DX-062).
  exports: [SessionClaimsService, SessionCookieService],
})
export class AuthModule {}
