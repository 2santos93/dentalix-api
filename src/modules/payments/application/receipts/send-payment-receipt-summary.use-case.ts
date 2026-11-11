import {
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  GetPaymentReceiptSummaryUseCase,
  type ReceiptSummaryPeriod,
} from './get-payment-receipt-summary.use-case';
import {
  PATIENT_WITHOUT_EMAIL_MESSAGE,
  type SendPaymentReceiptResult,
} from './send-payment-receipt.use-case';
import {
  PAYMENT_RECEIPT_SUMMARY_REPOSITORY,
  type PaymentReceiptSummaryRepository,
} from '../../domain/ports/payment-receipt-summary-repository.port';
import {
  RECEIPT_SUMMARY_EMAIL_SENDER,
  type ReceiptSummaryEmailSender,
} from '../../domain/ports/receipt-summary-email-sender.port';
import { RECEIPT_SUMMARY_EMPTY_MESSAGE } from '../../domain/receipt-summary';
import { maskEmail } from '../../../../shared/privacy/mask-email';
import { civilDateIn } from '../../../../shared/time/civil-day';
import { noticeRecipient } from '../../../patients/domain/communication/notice-recipient';
import {
  PAYMENT_CLOCK,
  type PaymentClock,
} from '../use-cases/void-payment.use-case';

/** Mismo cuerpo que el envío del recibo de un abono (DX-136). */
export type SendPaymentReceiptSummaryResult = SendPaymentReceiptResult;

/**
 * DX-401: envía por email el MISMO resumen que se ve y se imprime, con las
 * reglas del recibo de un abono (DX-136, DX-203): al email actual del
 * paciente o, si es menor (mayoría de edad de la clínica y día civil de la
 * sede del último recibo) o no tiene email, al responsable que recibe avisos.
 * Sin abonos en el período no hay nada que enviar (422). Sale por el outbox
 * con los topes de la clínica (429 en español).
 */
@Injectable()
export class SendPaymentReceiptSummaryUseCase {
  constructor(
    private readonly getSummary: GetPaymentReceiptSummaryUseCase,
    @Inject(PAYMENT_RECEIPT_SUMMARY_REPOSITORY)
    private readonly repo: PaymentReceiptSummaryRepository,
    @Inject(RECEIPT_SUMMARY_EMAIL_SENDER)
    private readonly sender: ReceiptSummaryEmailSender,
    @Inject(PAYMENT_CLOCK) private readonly now: PaymentClock,
  ) {}

  async execute(
    patientId: string,
    period: ReceiptSummaryPeriod,
  ): Promise<SendPaymentReceiptSummaryResult> {
    const { view, items } = await this.getSummary.load(patientId, period);
    const last = [...items].sort(
      (a, b) => b.issuedAt.getTime() - a.issuedAt.getTime(),
    )[0];
    if (!last) {
      throw new UnprocessableEntityException(RECEIPT_SUMMARY_EMPTY_MESSAGE);
    }
    const { patientEmail, notice } = await this.repo.recipient(
      patientId,
      last.locationId,
    );
    const recipient = noticeRecipient({
      patient: { ...notice.patient, email: patientEmail },
      responsibles: notice.responsibles,
      majorityAge: notice.settings.majorityAge,
      today: civilDateIn(this.now(), notice.settings.timeZone),
    });
    if (!recipient.email) {
      throw new UnprocessableEntityException(PATIENT_WITHOUT_EMAIL_MESSAGE);
    }
    const toResponsible = recipient.kind === 'RESPONSIBLE';
    await this.sender.send(
      recipient.email,
      view,
      last.locationId,
      toResponsible ? recipient.name : null,
    );
    return {
      sentTo: maskEmail(recipient.email),
      sentToResponsible: toResponsible,
    };
  }
}
