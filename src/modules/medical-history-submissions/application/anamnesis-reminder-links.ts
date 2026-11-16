import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { civilDateIn } from '../../../shared/time/civil-day';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { ANAMNESIS_QUESTIONNAIRE_VERSION } from '../domain/anamnesis-questionnaire';
import {
  ANAMNESIS_LINK_SENT_WITH_REMINDER_REASON,
  decideAnamnesisWithReminder,
  type AnamnesisReminderSkip,
} from '../domain/anamnesis-reminder-eligibility';
import {
  ANAMNESIS_PUBLIC_PATH,
  anamnesisLinkExpiry,
  generateAnamnesisToken,
  hashAnamnesisToken,
} from '../domain/anamnesis-token';
import {
  MEDICAL_HISTORY_SUBMISSION_REPOSITORY,
  type MedicalHistorySubmissionRepository,
} from '../domain/ports/medical-history-submission-repository.port';

/** La cita para la que sale el recordatorio (o el mensaje de confirmación). */
export interface AnamnesisLinkAppointment {
  id: string;
  patientId: string;
  locationId: string;
  start: Date;
  /** Zona IANA de la sede de la cita: el día civil con que se evalúa la vigencia. */
  timeZone: string;
}

/**
 * Quién la emite: el recordatorio automático (trabajo de la cola, sin
 * usuario: auditado con origen JOB) o recepción al generar el enlace de
 * confirmación para WhatsApp (auditado como suyo).
 */
export type AnamnesisLinkIssuer =
  { kind: 'REMINDER' } | { kind: 'STAFF'; audit: AuditRequestContext };

export type AnamnesisLinkOutcome =
  | {
      issued: true;
      submissionId: string;
      /** Texto plano: viaja SOLO en el email o el mensaje, nunca se guarda. */
      token: string;
      expiresAt: Date;
    }
  | { issued: false; reason: AnamnesisReminderSkip };

const SCHEDULABLE: ReadonlySet<string> = new Set(['SCHEDULED', 'CONFIRMED']);

/** `<base>/anamnesis/<token>` con la base `<protocolo>://<host>` de la clínica. */
export function anamnesisUrlFromBase(base: string, token: string): string {
  return `${base}${ANAMNESIS_PUBLIC_PATH}/${token}`;
}

/**
 * DX-290: el enlace de anamnesis que acompaña al recordatorio de una cita
 * (y al mensaje prellenado de WhatsApp del panel de confirmación) cuando el
 * paciente es nuevo o su anamnesis caducó el día de la cita
 * (`decideAnamnesisWithReminder`). Mismo enlace que el de recepción
 * (DX-099): un solo uso, hash en la BD, caduca a los 7 días o al inicio de
 * la cita, y emitirlo anula el que aún esperaba respuesta (un solo enlace
 * vivo por paciente). Va ligado a la cita: su panel muestra «Anamnesis
 * enviada».
 */
@Injectable()
export class AnamnesisReminderLinks {
  private readonly logger = new Logger('AnamnesisReminderLinks');

  constructor(
    @Inject(MEDICAL_HISTORY_SUBMISSION_REPOSITORY)
    private readonly repo: MedicalHistorySubmissionRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * El del panel de confirmación (recepción, para el mensaje de WhatsApp):
   * lee la cita por su id bajo RLS. Solo una cita agendada o confirmada que
   * no ha empezado.
   */
  async issueForAppointmentId(
    appointmentId: string,
    issuer: AnamnesisLinkIssuer,
    now: Date,
  ): Promise<AnamnesisLinkOutcome> {
    const appointment = await this.repo.findAppointmentForLink(appointmentId);
    if (
      !appointment ||
      !SCHEDULABLE.has(appointment.status) ||
      appointment.start.getTime() <= now.getTime()
    ) {
      return { issued: false, reason: 'NOT_SCHEDULABLE' };
    }
    if (!appointment.timeZone) return { issued: false, reason: 'NO_TIME_ZONE' };
    return this.issueFor(
      {
        id: appointment.id,
        patientId: appointment.patientId,
        locationId: appointment.locationId,
        start: appointment.start,
        timeZone: appointment.timeZone,
      },
      issuer,
      now,
    );
  }

  async issueFor(
    appointment: AnamnesisLinkAppointment,
    issuer: AnamnesisLinkIssuer,
    now: Date,
  ): Promise<AnamnesisLinkOutcome> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    const facts = await this.repo.loadReminderFacts(
      appointment.patientId,
      appointment.locationId,
    );
    if (!facts) return { issued: false, reason: 'ARCHIVED' };
    const decision = decideAnamnesisWithReminder({
      ...facts,
      appointmentDay: civilDateIn(appointment.start, appointment.timeZone),
      timeZone: appointment.timeZone,
    });
    if (!decision.send) return { issued: false, reason: decision.reason };

    const token = generateAnamnesisToken();
    try {
      const issued = await this.repo.issue({
        patientId: appointment.patientId,
        appointmentId: appointment.id,
        locationId: appointment.locationId,
        tokenHash: hashAnamnesisToken(token),
        expiresAt: anamnesisLinkExpiry(now, appointment.start),
        questionnaireVersion: ANAMNESIS_QUESTIONNAIRE_VERSION,
        origin: issuer.kind,
        createdById: issuer.kind === 'STAFF' ? issuer.audit.actor.userId : null,
        // Solo ids y el motivo: ni el token ni la URL van en el evento.
        audit: (submissionId) => ({
          tenantId,
          locationId: appointment.locationId,
          actor:
            issuer.kind === 'STAFF'
              ? {
                  kind: 'user',
                  userId: issuer.audit.actor.userId,
                  role: issuer.audit.actor.role,
                }
              : { kind: 'system' },
          action: 'CREATE',
          resourceType: 'MEDICAL_HISTORY_SUBMISSION',
          resourceId: submissionId,
          patient: { kind: 'patient', id: appointment.patientId },
          requestId: issuer.kind === 'STAFF' ? issuer.audit.requestId : null,
          ip: issuer.kind === 'STAFF' ? issuer.audit.ip : null,
          userAgent: issuer.kind === 'STAFF' ? issuer.audit.userAgent : null,
          metadata:
            issuer.kind === 'STAFF'
              ? { reason: 'ANAMNESIS_LINK_CREATED', origin: 'STAFF' }
              : {
                  reason: ANAMNESIS_LINK_SENT_WITH_REMINDER_REASON,
                  origin: 'JOB',
                },
        }),
      });
      this.logger.log({
        event: 'anamnesis.link_with_reminder',
        appointmentId: appointment.id,
        submissionId: issued.submission.id,
        origin: issuer.kind,
        status: decision.status,
      });
      return {
        issued: true,
        submissionId: issued.submission.id,
        token,
        expiresAt: issued.submission.expiresAt,
      };
    } catch (error) {
      // DX-461/DX-476: archivado entre la lectura y el alta (409 bajo el
      // candado del paciente): el recordatorio sale igual, sin enlace.
      if (error instanceof ConflictException) {
        return { issued: false, reason: 'ARCHIVED' };
      }
      throw error;
    }
  }
}
