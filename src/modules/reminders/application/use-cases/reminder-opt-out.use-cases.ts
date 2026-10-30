import { ConfigService } from '@nestjs/config';
import { optOutPositiveInteger } from '../opt-out-config';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ReminderOptOutSource } from '@prisma/client';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  firstNameOnly,
  hashConfirmationToken,
  isWellFormedConfirmationToken,
} from '../../../appointment-confirmations/application/confirmation-token';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import { normalizeMobile } from '../../../patients/domain/communication/mobile-number';
import { callingCodeOfCountry } from '../../../../shared/phone/country-calling-code';
import {
  REMINDER_OPT_OUT_REPOSITORY,
  type OptOutClinicBranding,
  type OptOutLinkLookup,
  type ReminderOptOutRepository,
} from '../../domain/ports/reminder-opt-out-repository.port';
import { isOptOutMessage } from '../../domain/opt-out-keywords';
import { ReminderClock } from '../reminder-clock';

const LINK_NOT_FOUND = 'Enlace de baja no encontrado';

/** Lo que ve el paciente en `/baja/[token]`: nada más que su nombre de pila. */
export interface PublicOptOutView {
  /** ACTIVE: sigue recibiendo recordatorios. OPTED_OUT: se dio de baja. */
  status: 'ACTIVE' | 'OPTED_OUT';
  patientFirstName: string | null;
  optedOutAt: Date | null;
  clinic: OptOutClinicBranding | null;
}

export interface OptOutRequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/**
 * Evento de auditoría de una baja que hizo el PROPIO paciente: sin usuario de
 * la clínica (actor `patient`), con el origen y el campo que cambió.
 */
function patientOptOutAudit(
  tenantId: string,
  patientId: string,
  origin: Extract<ReminderOptOutSource, 'LINK' | 'MESSAGE'>,
  meta: OptOutRequestMeta,
) {
  return {
    tenantId,
    locationId: null,
    actor: { kind: 'patient' as const },
    action: 'UPDATE' as const,
    resourceType: 'PATIENT' as const,
    resourceId: patientId,
    patient: { kind: 'patient' as const, id: patientId },
    requestId: meta.requestId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    metadata: {
      reason: 'REMINDER_OPT_OUT',
      origin,
      changedFields: ['reminderOptOutAt'],
    },
  };
}

/**
 * Búsqueda común de GET y POST públicos, como la confirmación de DX-005: el
 * tenant sale SOLO del host; sin él, o con un token que no puede ser nuestro,
 * 404 sin consultar. La RLS hace invisible un enlace de otra clínica (→ el
 * mismo 404 que uno inventado).
 */
async function findLink(
  tenantContext: TenantContextService,
  repo: ReminderOptOutRepository,
  token: string,
  at: Date,
): Promise<{ tenantId: string; link: OptOutLinkLookup }> {
  const tenantId = tenantContext.getTenantId();
  if (!tenantId || !isWellFormedConfirmationToken(token)) {
    throw new NotFoundException(LINK_NOT_FOUND);
  }
  const link = await repo.findLinkByTokenHash(hashConfirmationToken(token), at);
  if (!link) throw new NotFoundException(LINK_NOT_FOUND);
  return { tenantId, link };
}

function toView(
  link: OptOutLinkLookup,
  optedOutAt: Date | null,
  clinic: OptOutClinicBranding | null,
): PublicOptOutView {
  return {
    status: optedOutAt ? 'OPTED_OUT' : 'ACTIVE',
    patientFirstName: firstNameOnly(link.patientFirstName),
    optedOutAt,
    clinic,
  };
}

/**
 * PÚBLICO, solo lectura: abrir el enlace no da de baja (los antivirus y los
 * previsualizadores de correo abren los enlaces solos). La baja exige el POST
 * del botón de la página.
 */
@Injectable()
export class GetPublicOptOutUseCase {
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(REMINDER_OPT_OUT_REPOSITORY)
    private readonly repo: ReminderOptOutRepository,
    private readonly clock: ReminderClock,
  ) {}

  async execute(token: string): Promise<PublicOptOutView> {
    const { link } = await findLink(
      this.tenantContext,
      this.repo,
      token,
      this.clock.now(),
    );
    return toView(link, link.optedOutAt, await this.repo.clinicBranding());
  }
}

/**
 * PÚBLICO: el paciente confirma la baja desde el enlace del email (DX-128).
 * Consume el enlace una sola vez. Si la baja ya estaba vigente por otra vía,
 * conserva su fecha y no audita de nuevo; un enlace usado devuelve404.
 */
@Injectable()
export class ConfirmPublicOptOutUseCase {
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(REMINDER_OPT_OUT_REPOSITORY)
    private readonly repo: ReminderOptOutRepository,
    private readonly audit: RecordAuditEventUseCase,
    private readonly clock: ReminderClock,
  ) {}

  async execute(
    token: string,
    meta: OptOutRequestMeta,
  ): Promise<PublicOptOutView> {
    const { tenantId, link } = await findLink(
      this.tenantContext,
      this.repo,
      token,
      this.clock.now(),
    );
    const clinic = await this.repo.clinicBranding();

    const now = this.clock.now();
    const registered = await this.repo.optOut(link.patientId, {
      source: 'LINK',
      at: now,
      linkId: link.linkId,
    });
    if (registered === null) throw new NotFoundException(LINK_NOT_FOUND);
    if (!registered) return toView(link, link.optedOutAt ?? now, clinic);
    await this.audit.record(
      patientOptOutAudit(tenantId, link.patientId, 'LINK', meta),
    );
    return toView(link, now, clinic);
  }
}

export interface InboundReply {
  /** Clínica de la conversación (la resuelve el webhook de DX-126). */
  tenantId: string;
  /** Número del remitente tal como lo da el proveedor (E.164, con o sin `+`). */
  fromPhone: string;
  text: string;
  requestId?: string | null;
}

export interface InboundReplyResult {
  /** ¿El texto es una palabra de baja? */
  isOptOut: boolean;
  /** Pacientes a los que ESTA respuesta dio de baja (los ya dados de baja no). */
  optedOut: string[];
}

/**
 * Respuesta entrante al recordatorio (DX-128), lista para que el webhook de
 * WhatsApp Business de DX-126 la invoque al recibir cada mensaje. Si es una
 * palabra de baja («BAJA», «STOP», «NO MÁS»), registra la baja de TODOS los
 * pacientes vivos de la clínica con ese móvil (una madre que recibe los de sus
 * hijos pidió parar todos) y la audita con origen MESSAGE. Síncrono: la baja
 * queda escrita antes de responder al webhook, y el siguiente recordatorio la
 * relee al enviarse.
 */
@Injectable()
export class OptOutByMessageUseCase {
  private readonly logger = new Logger('Reminders');
  private readonly maxMatches: number;
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(REMINDER_OPT_OUT_REPOSITORY)
    private readonly repo: ReminderOptOutRepository,
    private readonly audit: RecordAuditEventUseCase,
    private readonly clock: ReminderClock,
    private readonly config: ConfigService = new ConfigService(),
  ) {
    this.maxMatches = optOutPositiveInteger(
      this.config,
      'REMINDER_OPT_OUT_MESSAGE_MAX_MATCHES',
      5,
    );
  }
  async execute(reply: InboundReply): Promise<InboundReplyResult> {
    if (!isOptOutMessage(reply.text)) return { isOptOut: false, optedOut: [] };
    const digits = reply.fromPhone.replace(/\D/g, '');
    const from = normalizeMobile(`+${digits}`, null);
    if (from.status !== 'VALID') return { isOptOut: true, optedOut: [] };

    return this.tenantContext.run(reply.tenantId, async () => {
      const callingCode = callingCodeOfCountry(
        await this.repo.principalLocationCountry(),
      );
      const candidates = await this.repo.findByPhoneTail(digits.slice(-8));
      const matches = candidates.filter(
        (c) => normalizeMobile(c.phone, callingCode).e164 === from.e164,
      );
      const limit = this.maxMatches;
      if (matches.length > limit) {
        await this.repo.recordMatchWarnings(
          matches.map((match) => match.patientId),
          matches.length,
          limit,
        );
        this.logger.warn({
          event: 'reminders.opt_out_match_limit',
          tenantId: reply.tenantId,
          matches: matches.length,
          limit,
        });
        return { isOptOut: true, optedOut: [] };
      }
      const now = this.clock.now();
      const optedOut: string[] = [];
      for (const { patientId } of matches) {
        if (await this.repo.optOut(patientId, { source: 'MESSAGE', at: now })) {
          optedOut.push(patientId);
          await this.audit.record(
            patientOptOutAudit(reply.tenantId, patientId, 'MESSAGE', {
              ip: null,
              userAgent: null,
              requestId: reply.requestId ?? null,
            }),
          );
        }
      }
      return { isOptOut: true, optedOut };
    });
  }
}
