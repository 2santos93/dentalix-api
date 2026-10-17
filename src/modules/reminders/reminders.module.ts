import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { JobsModule } from '../jobs/jobs.module';
import { EmailModule } from '../notifications/email/email.module';
import { OutboundMessagesModule } from '../notifications/outbound/outbound-messages.module';
import { AppointmentConfirmationsModule } from '../appointment-confirmations/appointment-confirmations.module';
import { ReminderSettingsController } from './presentation/reminder-settings.controller';
import { AppointmentRemindersController } from './presentation/appointment-reminders.controller';
import {
  ListReminderSettingsUseCase,
  UpdateReminderSettingsUseCase,
} from './application/use-cases/reminder-settings.use-cases';
import { GetAppointmentRemindersUseCase } from './application/use-cases/get-appointment-reminders.use-case';
import { PlanReminders } from './application/plan-reminders';
import { SendAppointmentReminder } from './application/send-appointment-reminder';
import { RemindersJobs } from './application/reminders-jobs';
import { ReminderClock } from './application/reminder-clock';
import { REMINDER_REPOSITORY } from './domain/ports/reminder-repository.port';
import { PrismaReminderRepository } from './infrastructure/prisma-reminder.repository';

/**
 * Recordatorio automático de cita por email, por sede (DX-026). Reutiliza la
 * cola y el cron con candado de DX-085, el registro de salientes
 * (outbound_messages), el email transaccional con outbox de DX-088 y el
 * enlace de confirmación firmado de DX-005.
 */
@Module({
  imports: [
    JwtModule.register({}),
    JobsModule,
    EmailModule,
    OutboundMessagesModule,
    AppointmentConfirmationsModule,
  ],
  controllers: [ReminderSettingsController, AppointmentRemindersController],
  providers: [
    ListReminderSettingsUseCase,
    UpdateReminderSettingsUseCase,
    GetAppointmentRemindersUseCase,
    PlanReminders,
    SendAppointmentReminder,
    RemindersJobs,
    ReminderClock,
    TokenService,
    TenantContextInterceptor,
    { provide: REMINDER_REPOSITORY, useClass: PrismaReminderRepository },
  ],
})
export class RemindersModule {}
