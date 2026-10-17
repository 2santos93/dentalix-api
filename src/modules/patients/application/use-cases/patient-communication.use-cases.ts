import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ContactChannel,
  ReminderOptOutSource,
  WhatsappOptInSource,
} from '@prisma/client';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { AuditOrigin } from '../../../audit/domain/audit-metadata';
import {
  normalizeMobile,
  type MobileStatus,
} from '../../domain/communication/mobile-number';
import {
  reminderRecipient,
  type ReminderRecipient,
} from '../../domain/communication/reminder-recipient';
import {
  PATIENT_COMMUNICATION_REPOSITORY,
  PATIENT_NOT_FOUND_MESSAGE,
  type PatientCommunicationPatch,
  type PatientCommunicationRepository,
  type PatientCommunicationState,
} from '../../domain/ports/patient-communication-repository.port';

export const WHATSAPP_NEEDS_VALID_MOBILE =
  'Para elegir WhatsApp el paciente necesita un móvil válido. Revisa el número (si es de otro país, escríbelo con + y su indicativo).';
const OPT_IN_SOURCE_REQUIRED =
  'Indica dónde aceptó el paciente que le escriban por WhatsApp: en persona, por enlace o por mensaje.';

export const COMMUNICATION_CLOCK = Symbol('COMMUNICATION_CLOCK');

/** Lo que muestra el bloque «Comunicaciones» de la ficha. */
export interface PatientCommunicationView {
  patientId: string;
  contactChannel: ContactChannel;
  clinicDefaultChannel: ContactChannel;
  /** Tal como está guardado. */
  phone: string | null;
  /** E.164 con `+`, solo si es un móvil válido. */
  phoneE164: string | null;
  phoneStatus: MobileStatus;
  /** País con el que se validó (el de la sede, o el del paciente). */
  phoneCountry: string | null;
  email: string | null;
  whatsappOptIn: {
    at: Date;
    source: WhatsappOptInSource;
    recordedBy: { id: string; fullName: string | null } | null;
  } | null;
  reminderOptOut: { at: Date; source: ReminderOptOutSource } | null;
  /** A quién se dirigen los avisos: un menor, a su tutor o contacto principal. */
  recipient: ReminderRecipient;
}

export interface UpdatePatientCommunicationInput {
  contactChannel?: ContactChannel;
  /** null o vacío = sin móvil. */
  phone?: string | null;
  whatsappOptIn?: boolean;
  whatsappOptInSource?: WhatsappOptInSource;
  reminderOptOut?: boolean;
}

function toView(
  state: PatientCommunicationState,
  country: string | null,
  clinicDefaultChannel: ContactChannel,
  now: Date,
): PatientCommunicationView {
  const mobile = normalizeMobile(state.phone, country);
  return {
    patientId: state.patientId,
    contactChannel: state.contactChannel,
    clinicDefaultChannel,
    phone: state.phone,
    phoneE164: mobile.e164,
    phoneStatus: mobile.status,
    phoneCountry: country,
    email: state.email,
    whatsappOptIn:
      state.whatsappOptInAt && state.whatsappOptInSource
        ? {
            at: state.whatsappOptInAt,
            source: state.whatsappOptInSource,
            recordedBy: state.whatsappOptInBy,
          }
        : null,
    reminderOptOut:
      state.reminderOptOutAt && state.reminderOptOutSource
        ? { at: state.reminderOptOutAt, source: state.reminderOptOutSource }
        : null,
    recipient: reminderRecipient(state, now),
  };
}

/** 400 `WHATSAPP_REQUIRES_VALID_MOBILE`, también para la edición general. */
export function whatsappMobileRequiredError(): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'WHATSAPP_REQUIRES_VALID_MOBILE',
    message: WHATSAPP_NEEDS_VALID_MOBILE,
  });
}

/** País del móvil: el de la sede (DX-128) o, sin sedes, el del paciente. */
async function phoneCountry(
  repo: PatientCommunicationRepository,
  state: PatientCommunicationState,
): Promise<string | null> {
  return (await repo.locationCountry()) ?? state.countryCode;
}

@Injectable()
export class GetPatientCommunicationUseCase {
  constructor(
    @Inject(PATIENT_COMMUNICATION_REPOSITORY)
    private readonly repo: PatientCommunicationRepository,
    @Inject(COMMUNICATION_CLOCK) private readonly clock: () => Date,
  ) {}

  async execute(patientId: string): Promise<PatientCommunicationView> {
    const state = await this.repo.find(patientId);
    if (!state) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    const [country, clinicDefault] = await Promise.all([
      phoneCountry(this.repo, state),
      this.repo.clinicDefaultChannel(),
    ]);
    return toView(state, country, clinicDefault, this.clock());
  }
}

/**
 * Cambia el canal, el móvil, el opt-in de WhatsApp o la baja de los
 * recordatorios desde la ficha (DX-128; solo recepción y ADMIN, lo exige el
 * controlador). Reglas:
 * - El móvil se normaliza a E.164 con el país de la sede al guardar; uno
 *   inválido se guarda tal cual (la ficha avisa), salvo que el canal sea o
 *   pase a ser WHATSAPP: entonces 400 en español y no se guarda nada.
 * - El opt-in de WhatsApp exige su origen y un móvil válido; guarda fecha,
 *   origen y quién lo registró. Retirarlo borra los tres.
 * - La baja anotada por recepción queda con origen STAFF; quitarla reactiva
 *   los recordatorios.
 * - Cada cambio real deja UN evento de auditoría con el autor, los campos
 *   cambiados y el origen (el del opt-in si se acaba de dar; si no, STAFF).
 *   Sin cambios reales no se escribe nada.
 */
@Injectable()
export class UpdatePatientCommunicationUseCase {
  constructor(
    @Inject(PATIENT_COMMUNICATION_REPOSITORY)
    private readonly repo: PatientCommunicationRepository,
    private readonly audit: RecordAuditEventUseCase,
    @Inject(COMMUNICATION_CLOCK) private readonly clock: () => Date,
  ) {}

  async execute(
    patientId: string,
    input: UpdatePatientCommunicationInput,
    ctx: AuditRequestContext,
  ): Promise<PatientCommunicationView> {
    const state = await this.repo.find(patientId);
    if (!state) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    const [country, clinicDefault] = await Promise.all([
      phoneCountry(this.repo, state),
      this.repo.clinicDefaultChannel(),
    ]);
    const now = this.clock();
    const patch: PatientCommunicationPatch = {};
    const changed: string[] = [];
    let origin: AuditOrigin = 'STAFF';

    let phone = state.phone;
    if (input.phone !== undefined) {
      const typed = input.phone?.trim() || null;
      const mobile = normalizeMobile(typed, country);
      phone = mobile.e164 ?? typed;
      if (phone !== state.phone) {
        patch.phone = phone;
        changed.push('phone');
      }
    }
    const mobileValid = normalizeMobile(phone, country).status === 'VALID';

    const channel = input.contactChannel ?? state.contactChannel;
    if (
      channel === 'WHATSAPP' &&
      (input.contactChannel !== undefined || input.phone !== undefined) &&
      !mobileValid
    ) {
      throw whatsappMobileRequiredError();
    }
    if (channel !== state.contactChannel) {
      patch.contactChannel = channel;
      changed.push('contactChannel');
    }

    if (input.whatsappOptIn === true && !state.whatsappOptInAt) {
      if (!input.whatsappOptInSource) {
        throw new BadRequestException(OPT_IN_SOURCE_REQUIRED);
      }
      if (!mobileValid) throw whatsappMobileRequiredError();
      patch.whatsappOptInAt = now;
      patch.whatsappOptInSource = input.whatsappOptInSource;
      patch.whatsappOptInById = ctx.actor.userId;
      origin = input.whatsappOptInSource;
      changed.push('whatsappOptIn');
    } else if (input.whatsappOptIn === false && state.whatsappOptInAt) {
      patch.whatsappOptInAt = null;
      patch.whatsappOptInSource = null;
      patch.whatsappOptInById = null;
      changed.push('whatsappOptIn');
    }

    if (input.reminderOptOut === true && !state.reminderOptOutAt) {
      patch.reminderOptOutAt = now;
      patch.reminderOptOutSource = 'STAFF';
      changed.push('reminderOptOutAt');
    } else if (input.reminderOptOut === false && state.reminderOptOutAt) {
      patch.reminderOptOutAt = null;
      patch.reminderOptOutSource = null;
      changed.push('reminderOptOutAt');
    }

    if (changed.length === 0) {
      return toView(state, country, clinicDefault, now);
    }

    const saved = await this.repo.update(patientId, patch);
    await this.audit.record({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action: 'UPDATE',
      resourceType: 'PATIENT',
      resourceId: patientId,
      patient: { kind: 'patient', id: patientId },
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: {
        reason: 'COMMUNICATION_PREFERENCES_CHANGED',
        origin,
        changedFields: [...changed].sort(),
      },
    });
    return toView(saved, country, clinicDefault, now);
  }
}
