import { MedicalHistorySubmissionsModule } from '../medical-history-submissions/medical-history-submissions.module';
import { Module } from '@nestjs/common';
import { MessageTemplatesModule } from '../message-templates/message-templates.module';
import { JwtModule } from '@nestjs/jwt';
import { ConfirmationLinksController } from './presentation/confirmation-links.controller';
import { PublicAppointmentConfirmationsController } from './presentation/public-appointment-confirmations.controller';
import { CreateConfirmationLinkUseCase } from './application/use-cases/create-confirmation-link.use-case';
import { GetPublicConfirmationUseCase } from './application/use-cases/get-public-confirmation.use-case';
import { RespondConfirmationUseCase } from './application/use-cases/respond-confirmation.use-case';
import { SetWantsEarlierFromLinkUseCase } from './application/use-cases/set-wants-earlier-from-link.use-case';
import { GetConfirmationCalendarUseCase } from './application/use-cases/get-confirmation-calendar.use-case';
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
  // DX-290: el enlace de anamnesis que acompaña al de confirmación.
  imports: [
    JwtModule.register({}),
    MedicalHistorySubmissionsModule,
    // DX-565: el texto de la clínica para el wa.me de la confirmación.
    MessageTemplatesModule,
  ],
  controllers: [
    ConfirmationLinksController,
    PublicAppointmentConfirmationsController,
  ],
  providers: [
    CreateConfirmationLinkUseCase,
    GetPublicConfirmationUseCase,
    RespondConfirmationUseCase,
    SetWantsEarlierFromLinkUseCase,
    GetConfirmationCalendarUseCase,
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
  // DX-101: el portal del paciente confirma por este mismo flujo.
  // DX-265: «Ya llegué» resuelve el enlace con el mismo repositorio.
  exports: [
    CreateConfirmationLinkUseCase,
    RespondConfirmationUseCase,
    APPOINTMENT_CONFIRMATION_REPOSITORY,
  ],
})
export class AppointmentConfirmationsModule {}
