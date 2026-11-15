import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { requireLocationFormat } from '../../../../shared/locations/location-regional';
import { whatsAppDigits } from '../../../../shared/phone/phone-number';
import { maskEmail } from '../../../../shared/privacy/mask-email';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { PreparedEmail } from '../../../notifications/email/application/email-outbox.service';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../../patients/application/assert-patient-in-clinic';
import {
  isPlanBillable,
  notBillableMessage,
} from '../../../treatment-plans/domain/plan-status-machine';
import {
  PAYMENT_LINK_BALANCE_NOT_FOUND_MESSAGE,
  PAYMENT_LINK_CURRENCY_MESSAGE,
  PAYMENT_LINK_NO_EMAIL_MESSAGE,
  PAYMENT_LINK_NO_HOST_MESSAGE,
  PAYMENT_LINK_NO_WHATSAPP_MESSAGE,
  PAYMENT_LINK_PLAN_NOT_FOUND_MESSAGE,
  PAYMENT_LINK_TARGET_REQUIRED_MESSAGE,
  buildPaymentLinkUrl,
  firstNameOnly,
  generatePaymentLinkToken,
  hashPaymentLinkToken,
  paymentLinkExpiresAt,
  paymentLinkStatus,
  paymentLinkWhatsAppMessage,
  type PaymentLinkChannel,
  type PaymentLinkConcept,
  type PaymentLinkStatus,
} from '../../domain/payment-link';
import {
  PAYMENT_LINK_REPOSITORY,
  type PatientPaymentLinkRow,
  type PaymentLinkRepository,
} from '../../domain/ports/payment-link-repository.port';
import {
  PAYMENT_LINK_EMAILS,
  type PaymentLinkEmails,
} from '../payment-link-emails';
import {
  PAYMENT_LINKS_CLOCK,
  type PaymentLinksClock,
} from '../payment-links-clock';

export interface CreatePaymentLinkInput {
  target: { treatmentPlanId?: string; openingBalanceId?: string };
  amount: number;
  /** Si llega, tiene que ser la del destino (la moneda es la suya). */
  currency?: string;
  /** Sin canal: solo se devuelve la URL para copiarla. */
  channel?: PaymentLinkChannel | null;
}

export interface CreatedPaymentLink {
  id: string;
  /** La URL con el token: solo en esta respuesta (no se guarda). */
  url: string;
  expiresAt: Date;
  amount: number;
  currency: string;
  concept: PaymentLinkConcept;
  channel: PaymentLinkChannel | null;
  /** EMAIL: destino enmascarado; si no, null. */
  emailSentTo: string | null;
  /** WHATSAPP: el número para `wa.me` y el texto, sin importes; si no, null. */
  whatsapp: { phone: string; text: string } | null;
  /** Enlaces anteriores del mismo destino que se anularon. */
  revokedPrevious: number;
}

/**
 * «Enviar enlace de pago» (D2, D3): un enlace de 7 días para un plan cobrable
 * o un saldo migrado del paciente, con la foto de lo pedido (importe, moneda
 * del destino, sede y concepto). Crear uno anula el vivo del mismo destino.
 * El token solo viaja en la URL de la respuesta y en el mensaje.
 */
@Injectable()
export class CreatePaymentLinkUseCase {
  constructor(
    @Inject(PAYMENT_LINK_REPOSITORY)
    private readonly repo: PaymentLinkRepository,
    @Inject(PAYMENT_LINK_EMAILS) private readonly emails: PaymentLinkEmails,
    private readonly tenantContext: TenantContextService,
    @Inject(PAYMENT_LINKS_CLOCK) private readonly clock: PaymentLinksClock,
  ) {}

  async execute(
    patientId: string,
    input: CreatePaymentLinkInput,
    createdById: string,
    link: { protocol: string; host: string | null },
  ): Promise<CreatedPaymentLink> {
    const patient = await this.repo.findPatient(patientId);
    if (!patient) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    const target = await this.resolveTarget(patientId, input.target);
    if (
      input.currency &&
      input.currency.trim().toUpperCase() !== target.currency
    ) {
      throw new BadRequestException(PAYMENT_LINK_CURRENCY_MESSAGE);
    }
    const location = await this.repo.linkLocation(target.locationId);
    // SEC-045: un enlace de una sede no permitida al usuario es 403 antes de
    // emitir nada (la bandeja también filtra por la sede del enlace).
    this.tenantContext.assertLocationAllowed(location.id);
    // El host entero se valida antes de escribir nada: uno manipulado no
    // arma un enlace hacia otro sitio (safeLinkHost en el controlador).
    if (!link.host) throw new BadRequestException(PAYMENT_LINK_NO_HOST_MESSAGE);

    const channel = input.channel ?? null;
    const now = this.clock();
    const expiresAt = paymentLinkExpiresAt(now);
    const token = generatePaymentLinkToken();
    const url = buildPaymentLinkUrl(`${link.protocol}://${link.host}`, token);
    const id = randomUUID();
    const clinicName = await this.repo.clinicName();
    const firstName = firstNameOnly(patient.firstName);

    let whatsapp: { phone: string; text: string } | null = null;
    if (channel === 'WHATSAPP') {
      const phone = whatsAppDigits(patient.phone, location.defaultPhoneRegion);
      if (!phone) {
        throw new UnprocessableEntityException(
          PAYMENT_LINK_NO_WHATSAPP_MESSAGE,
        );
      }
      whatsapp = {
        phone,
        text: paymentLinkWhatsAppMessage({ firstName, clinicName, url }),
      };
    }

    let mail: PreparedEmail | null = null;
    if (channel === 'EMAIL') {
      const email = patient.email?.trim();
      if (!email) {
        throw new UnprocessableEntityException(PAYMENT_LINK_NO_EMAIL_MESSAGE);
      }
      // Aviso temprano (429 antes de tocar nada); el que cuenta es el del
      // INSERT bajo candado, dentro de la transacción del enlace.
      await this.emails.assertCanSend(email);
      const format = requireLocationFormat(location);
      mail = await this.emails.prepareLink({
        to: email,
        linkId: id,
        vars: {
          patientFirstName: firstName,
          clinicName,
          url,
          expiresAtLabel: format.longDateTime(
            expiresAt,
            location.timeZone ?? 'UTC',
          ),
        },
      });
    }

    const issued = await this.repo.issueLink({
      id,
      patientId,
      treatmentPlanId: target.treatmentPlanId,
      openingBalanceId: target.openingBalanceId,
      locationId: location.id,
      amount: input.amount,
      currency: target.currency,
      concept: target.concept,
      tokenHash: hashPaymentLinkToken(token),
      expiresAt,
      channel,
      createdById,
      now,
      enqueue: mail
        ? async (tx) => {
            await mail.insert(tx);
          }
        : undefined,
    });
    mail?.kick();
    return {
      id: issued.id,
      url,
      expiresAt,
      amount: input.amount,
      currency: target.currency,
      concept: target.concept,
      channel,
      emailSentTo:
        channel === 'EMAIL' && patient.email ? maskEmail(patient.email) : null,
      whatsapp,
      revokedPrevious: issued.revoked,
    };
  }

  /** Exactamente un destino, del paciente y cobrable (D2). */
  private async resolveTarget(
    patientId: string,
    target: CreatePaymentLinkInput['target'],
  ): Promise<{
    treatmentPlanId: string | null;
    openingBalanceId: string | null;
    currency: string;
    concept: PaymentLinkConcept;
    locationId: string | null;
  }> {
    const planId = target.treatmentPlanId ?? null;
    const balanceId = target.openingBalanceId ?? null;
    if ((planId === null) === (balanceId === null)) {
      throw new BadRequestException(PAYMENT_LINK_TARGET_REQUIRED_MESSAGE);
    }
    if (planId !== null) {
      const plan = await this.repo.findPlanTarget(patientId, planId);
      if (!plan)
        throw new NotFoundException(PAYMENT_LINK_PLAN_NOT_FOUND_MESSAGE);
      if (!isPlanBillable(plan.status)) {
        throw new ConflictException(notBillableMessage(plan.status));
      }
      return {
        treatmentPlanId: plan.id,
        openingBalanceId: null,
        currency: plan.currency,
        concept: plan.hasActivePaymentPlan ? 'INSTALLMENT' : 'BALANCE',
        locationId: plan.locationId,
      };
    }
    const balance = await this.repo.findBalanceTarget(patientId, balanceId!);
    if (!balance) {
      throw new NotFoundException(PAYMENT_LINK_BALANCE_NOT_FOUND_MESSAGE);
    }
    return {
      treatmentPlanId: null,
      openingBalanceId: balance.id,
      currency: balance.currency,
      concept: 'BALANCE',
      locationId: balance.locationId,
    };
  }
}

export interface PatientPaymentLinkView extends Omit<
  PatientPaymentLinkRow,
  'usedAt'
> {
  usedAt: Date | null;
  status: PaymentLinkStatus;
}

/** `GET /patients/:id/payment-links`: los enlaces del paciente con su estado. */
@Injectable()
export class ListPatientPaymentLinksUseCase {
  constructor(
    @Inject(PAYMENT_LINK_REPOSITORY)
    private readonly repo: PaymentLinkRepository,
    @Inject(PAYMENT_LINKS_CLOCK) private readonly clock: PaymentLinksClock,
  ) {}

  async execute(patientId: string): Promise<PatientPaymentLinkView[]> {
    const rows = await this.repo.listForPatient(patientId);
    if (!rows) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    const now = this.clock();
    return rows.map((row) => ({ ...row, status: paymentLinkStatus(row, now) }));
  }
}
