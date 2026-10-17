import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfirmationLinksController } from './presentation/confirmation-links.controller';
import { PublicAppointmentConfirmationsController } from './presentation/public-appointment-confirmations.controller';
import { CreateConfirmationLinkUseCase } from './application/use-cases/create-confirmation-link.use-case';
import { GetPublicConfirmationUseCase } from './application/use-cases/get-public-confirmation.use-case';
import { RespondConfirmationUseCase } from './application/use-cases/respond-confirmation.use-case';
import { APPOINTMENT_CONFIRMATION_REPOSITORY } from './domain/ports/appointment-confirmation-repository.port';
import { PrismaAppointmentConfirmationRepository } from './infrastructure/repositories/prisma-appointment-confirmation.repository';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { PublicTenantContextInterceptor } from '../../shared/tenancy/public-tenant-context.interceptor';

/**
 * DX-005: confirmación de cita por enlace firmado. Ruta autenticada para que
 * recepción genere el enlace + rutas públicas para que el paciente lo vea y
 * responda. Mismo cableado que InvitationsModule (JwtModule para el
 * JwtAuthGuard, los dos interceptores de tenant como providers).
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [
    ConfirmationLinksController,
    PublicAppointmentConfirmationsController,
  ],
  providers: [
    CreateConfirmationLinkUseCase,
    GetPublicConfirmationUseCase,
    RespondConfirmationUseCase,
    TokenService,
    TenantContextInterceptor,
    PublicTenantContextInterceptor,
    {
      provide: APPOINTMENT_CONFIRMATION_REPOSITORY,
      useClass: PrismaAppointmentConfirmationRepository,
    },
  ],
  // Los recordatorios automáticos (DX-026) emiten el enlace con el MISMO caso
  // de uso que recepción.
  exports: [CreateConfirmationLinkUseCase],
})
export class AppointmentConfirmationsModule {}
