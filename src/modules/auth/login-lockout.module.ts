import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoginLockoutService } from './application/login-lockout.service';
import {
  LOGIN_LOCKOUT_CONFIG,
  type LoginLockoutConfig,
  loadLoginLockoutConfig,
} from './domain/login-lockout';
import { LOGIN_THROTTLE_REPOSITORY } from './domain/ports/login-throttle-repository.port';
import { PrismaLoginThrottleRepository } from './infrastructure/repositories/prisma-login-throttle.repository';

/**
 * Bloqueo del login por fallos (DX-048). Módulo propio para que lo usen el
 * login (AuthModule) y el desbloqueo por un ADMIN (StaffModule) sin que uno
 * importe al otro. La configuración es un proveedor aparte: un test la
 * sustituye con `overrideProvider(LOGIN_LOCKOUT_CONFIG)`. Un valor inválido en
 * el entorno hace fallar el arranque.
 */
@Module({
  providers: [
    {
      provide: LOGIN_LOCKOUT_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): LoginLockoutConfig =>
        loadLoginLockoutConfig((key) => config.get<string>(key)),
    },
    {
      provide: LOGIN_THROTTLE_REPOSITORY,
      useClass: PrismaLoginThrottleRepository,
    },
    LoginLockoutService,
  ],
  exports: [LoginLockoutService, LOGIN_LOCKOUT_CONFIG],
})
export class LoginLockoutModule {}
