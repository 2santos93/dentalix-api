import { Inject, Injectable, Logger } from '@nestjs/common';
import { CreateConfirmationLinkUseCase } from '../../appointment-confirmations/application/use-cases/create-confirmation-link.use-case';
import { OutboundMessages } from '../../notifications/outbound/application/outbound-messages.service';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { JobPayload } from '../../jobs/domain/job';
import {
  REMINDER_REPOSITORY,
  type ReminderRepository,
} from '../domain/ports/reminder-repository.port';
import { decideReminder } from '../domain/reminder-window';
import { startsAtLabel } from '../domain/starts-at-label';
import { MAX_LEAD_HOURS, MIN_LEAD_HOURS } from '../domain/reminder-lead-hours';
import { CONFIRMATION_PATH } from '../../appointment-confirmations/presentation/confirmation-url';
import { TenantLinkBaseService } from '../../../shared/tenancy/tenant-link-base.service';
import { ReminderClock } from './reminder-clock';

const TEMPLATE = 'appointment-reminder';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ParsedPayload {
  appointmentId: string;
  leadHours: number;
  start: Date;
}

function parsePayload(payload: JobPayload): ParsedPayload {
  const { appointmentId, leadHours, start } = payload;
  const startDate = typeof start === 'string' ? new Date(start) : null;
  if (
    typeof appointmentId !== 'string' ||
    !UUID.test(appointmentId) ||
    typeof leadHours !== 'number' ||
    !Number.isInteger(leadHours) ||
    leadHours < MIN_LEAD_HOURS ||
    leadHours > MAX_LEAD_HOURS ||
    !startDate ||
    Number.isNaN(startDate.getTime())
  ) {
    throw new Error('reminders.send-email: payload inválido');
  }
  return { appointmentId, leadHours, start: startDate };
}

/**
 * Handler del envío de UN recordatorio (DX-026). Corre como trabajo de la
 * cola con el tenant del trabajo en el contexto, y NO se fía del payload
 * (SEC-036: `jobs` no tiene RLS): relee cita, paciente y ajustes de la sede
 * bajo RLS, así que un id de otra clínica no encuentra nada y no se envía.
 *
 * Idempotente (la cola entrega «al menos una vez»): la fila de
 * appointment_reminders, única por (cita, antelación, hora de inicio), es el
 * reclamo. Un intento caído a mitad se retoma donde quedó: si el email ya
 * está en email_outbox no se vuelve a encolar.
 */
@Injectable()
export class SendAppointmentReminder {
  private readonly logger = new Logger('Reminders');

  constructor(
    @Inject(REMINDER_REPOSITORY) private readonly repo: ReminderRepository,
    private readonly createLink: CreateConfirmationLinkUseCase,
    private readonly outbound: OutboundMessages,
    private readonly email: EmailOutbox,
    private readonly links: TenantLinkBaseService,
    private readonly clock: ReminderClock,
    private readonly tenantContext: TenantContextService,
  ) {}

  async handle(payload: JobPayload): Promise<void> {
    const { appointmentId, leadHours, start } = parsePayload(payload);
    const ctx = await this.repo.loadSendContext(appointmentId);
    if (!ctx) {
      this.logger.warn({
        event: 'reminders.appointment_missing',
        appointmentId,
      });
      return;
    }
    const decision = decideReminder({
      appointment: ctx.appointment,
      expectedStart: start,
      leadHours,
      settings: ctx.settings,
      patientEmail: ctx.patientEmail,
      now: this.clock.now(),
    });
    if (decision.action === 'SKIP') {
      const recorded = await this.repo.recordSkipped(
        appointmentId,
        leadHours,
        start,
        decision.reason,
      );
      this.logger.log({
        event: 'reminders.skipped',
        appointmentId,
        leadHours,
        reason: decision.reason,
        recorded,
      });
      return;
    }

    const claim = await this.repo.claim(appointmentId, leadHours, start);
    if (claim.status !== 'SENDING') return;
    if (
      claim.outboundMessageId &&
      (await this.repo.emailQueuedFor(claim.outboundMessageId))
    ) {
      await this.finish(
        claim.id,
        claim.outboundMessageId,
        appointmentId,
        leadHours,
      );
      return;
    }

    const to = (ctx.patientEmail ?? '').trim();
    const tenantId = this.tenantContext.getTenantId();
    // El trabajo corre bajo su clínica (su repositorio ya lo exige); el email
    // es de la clínica, nunca de plataforma (DX-144: EmailOutbox.enqueue la
    // pide).
    if (!tenantId) throw new Error('No tenant in context');
    // Sin petición: el host de PLATAFORMA de la clínica (`<sub>.<base>`),
    // nunca su dominio personalizado (SEC-033). null = sale sin enlace.
    const linkBase = await this.links.forTenant(tenantId);
    const link = await this.createLink.execute({
      appointmentId,
      automatic: true,
    });
    const outboundId =
      claim.outboundMessageId ??
      (
        await this.outbound.record({
          channel: 'EMAIL',
          template: TEMPLATE,
          recipient: to,
          appointmentId,
        })
      ).id;
    if (!claim.outboundMessageId) {
      await this.repo.attachOutbound(claim.id, outboundId);
    }
    await this.email.enqueue({
      tenantId,
      to,
      template: TEMPLATE,
      referenceId: outboundId,
      vars: {
        patientName: link.appointment.patientFirstName ?? '',
        startsAtLabel: startsAtLabel(
          ctx.appointment.start,
          ctx.locationTimeZone,
          ctx.locationCountry,
        ),
        locationName: link.appointment.locationName,
        locationAddress: link.appointment.locationAddress,
        providerName: link.appointment.providerName,
        confirmUrl: linkBase
          ? `${linkBase}${CONFIRMATION_PATH}/${link.token}`
          : null,
      },
    });
    await this.finish(claim.id, outboundId, appointmentId, leadHours);
  }

  private async finish(
    reminderId: string,
    outboundId: string,
    appointmentId: string,
    leadHours: number,
  ): Promise<void> {
    await this.outbound.settle(outboundId, { status: 'QUEUED' });
    await this.repo.markSent(reminderId, this.clock.now());
    this.logger.log({
      event: 'reminders.sent',
      appointmentId,
      leadHours,
      outboundId,
    });
  }
}
