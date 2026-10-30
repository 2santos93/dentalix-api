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
  noticeRecipient,
  type NoticeRecipient,
} from '../../domain/communication/notice-recipient';
import { civilDateIn } from '../../../../shared/time/civil-day';
import {
  parsePhone,
  phoneInternational,
  phoneRegionOrNull,
  type PhoneRegion,
} from '../../../../shared/phone/phone-number';
import {
  PATIENT_COMMUNICATION_REPOSITORY,
  PATIENT_NOT_FOUND_MESSAGE,
  type PatientCommunicationPatch,
  type PatientOptOutMatchWarningView,
  type PatientCommunicationRepository,
  type PatientCommunicationState,
} from '../../domain/ports/patient-communication-repository.port';

export const WHATSAPP_NEEDS_VALID_MOBILE =
  'Para elegir WhatsApp el paciente necesita un móvil válido. Revisa el número o escríbelo con + y su prefijo.';
/** El mismo 400 para un número que se lee de dos formas (DX-329, R10). */
export const WHATSAPP_AMBIGUOUS_NUMBER =
  'Ese número se puede leer de dos formas. Escríbelo con + y su prefijo.';
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
  /**
   * Los dígitos se leen como dos números válidos distintos (DX-329, R10): hay
   * que escribirlo con `+`.
   */
  phoneAmbiguous: boolean;
  /** Formato internacional de la librería, con su extensión; null si no es válido. */
  phoneInternational: string | null;
  /**
   * Región con la que se leyó (la por defecto de la sede activa o la
   * principal), o `null` si la sede no tiene prefijo por defecto.
   */
  phoneCountry: PhoneRegion | null;
  email: string | null;
  whatsappOptIn: {
    at: Date;
    source: WhatsappOptInSource;
    recordedBy: { id: string; fullName: string | null } | null;
  } | null;
  reminderOptOut: { at: Date; source: ReminderOptOutSource } | null;
  /**
   * A quién van los avisos (DX-203): un menor o un paciente sin email, a su
   * responsable; un menor sin responsable con email, saludando al responsable
   * o al contacto principal (DX-128).
   */
  recipient: NoticeRecipient;
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
  region: PhoneRegion | null,
  clinicDefaultChannel: ContactChannel,
  now: Date,
): PatientCommunicationView {
  const mobile = normalizeMobile(state.phone, region);
  return {
    patientId: state.patientId,
    contactChannel: state.contactChannel,
    clinicDefaultChannel,
    phone: state.phone,
    phoneE164: mobile.e164,
    phoneStatus: mobile.status,
    phoneAmbiguous: mobile.ambiguous,
    phoneInternational: phoneInternational(state.phone, region),
    phoneCountry: phoneRegionOrNull(region),
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
    recipient: noticeRecipient({
      patient: state,
      responsibles: state.responsibles,
      majorityAge: state.noticeSettings.majorityAge,
      today: civilDateIn(now, state.noticeSettings.timeZone),
    }),
  };
}

/**
 * 400 `WHATSAPP_REQUIRES_VALID_MOBILE`, también para la edición general. Si
 * el número se lee de dos formas, el mismo código pide escribirlo con `+`.
 */
export function whatsappMobileRequiredError(
  ambiguous = false,
): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'WHATSAPP_REQUIRES_VALID_MOBILE',
    message: ambiguous
      ? WHATSAPP_AMBIGUOUS_NUMBER
      : WHATSAPP_NEEDS_VALID_MOBILE,
  });
}

/**
 * Lo que se guarda al escribir el móvil (DX-329, R9 bis): el E.164 si es un
 * móvil válido sin extensión; si no, el texto tal cual.
 */
export function storedMobile(
  typed: string | null,
  region: PhoneRegion | null,
): string | null {
  const mobile = normalizeMobile(typed, region);
  return mobile.e164 && !parsePhone(typed, region)?.ext ? mobile.e164 : typed;
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
    const [region, clinicDefault] = await Promise.all([
      this.repo.defaultPhoneRegion(),
      this.repo.clinicDefaultChannel(),
    ]);
    return toView(state, region, clinicDefault, this.clock());
  }
}

/**
 * Cambia el canal, el móvil, el opt-in de WhatsApp o la baja de los
 * recordatorios desde la ficha (DX-128; solo recepción y ADMIN, lo exige el
 * controlador). Reglas:
 * - El móvil se normaliza a E.164 con la región de la sede al guardar; uno
 *   inválido, ambiguo o con extensión se guarda tal cual (la ficha avisa),
 *   salvo que el canal sea o pase a ser WHATSAPP sin un móvil válido:
 *   entonces 400 en español y no se guarda nada.
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
    const [region, clinicDefault] = await Promise.all([
      this.repo.defaultPhoneRegion(),
      this.repo.clinicDefaultChannel(),
    ]);
    const now = this.clock();
    const saved = await this.repo.update(
      patientId,
      (state) => {
        const patch: PatientCommunicationPatch = {};
        let phone = state.phone;
        if (input.phone !== undefined) {
          const typed = input.phone?.trim() || null;
          phone = storedMobile(typed, region);
          if (phone !== state.phone) {
            patch.phone = phone;
          }
        }
        const mobile = normalizeMobile(phone, region);
        const mobileValid = mobile.status === 'VALID';

        const channel = input.contactChannel ?? state.contactChannel;
        if (
          channel === 'WHATSAPP' &&
          (input.contactChannel !== undefined || input.phone !== undefined) &&
          !mobileValid
        ) {
          throw whatsappMobileRequiredError(mobile.ambiguous);
        }
        if (channel !== state.contactChannel) {
          patch.contactChannel = channel;
        }

        if (input.whatsappOptIn === true && !state.whatsappOptInAt) {
          if (!input.whatsappOptInSource) {
            throw new BadRequestException(OPT_IN_SOURCE_REQUIRED);
          }
          if (!mobileValid) throw whatsappMobileRequiredError(mobile.ambiguous);
          patch.whatsappOptInAt = now;
          patch.whatsappOptInSource = input.whatsappOptInSource;
          patch.whatsappOptInById = ctx.actor.userId;
        } else if (input.whatsappOptIn === false && state.whatsappOptInAt) {
          patch.whatsappOptInAt = null;
          patch.whatsappOptInSource = null;
          patch.whatsappOptInById = null;
        }

        if (input.reminderOptOut === true && !state.reminderOptOutAt) {
          patch.reminderOptOutAt = now;
          patch.reminderOptOutSource = 'STAFF';
        } else if (input.reminderOptOut === false) {
          patch.reminderOptOutAt = null;
          patch.reminderOptOutSource = null;
        }

        return patch;
      },
      input.reminderOptOut === false ? now : undefined,
    );
    if (!saved.changedFields.length)
      return toView(saved.state, region, clinicDefault, now);
    const origin: AuditOrigin =
      saved.changedFields.includes('whatsappOptIn') &&
      input.whatsappOptIn === true
        ? (saved.state.whatsappOptInSource ?? 'STAFF')
        : 'STAFF';
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
        changedFields: saved.changedFields,
      },
    });
    return toView(saved.state, region, clinicDefault, now);
  }
}

@Injectable()
export class GetPatientOptOutWarningsUseCase {
  constructor(
    @Inject(PATIENT_COMMUNICATION_REPOSITORY)
    private readonly repo: PatientCommunicationRepository,
  ) {}
  async execute(patientId: string): Promise<PatientOptOutMatchWarningView[]> {
    const warnings = await this.repo.optOutWarnings(patientId);
    if (!warnings) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    return warnings;
  }
}
