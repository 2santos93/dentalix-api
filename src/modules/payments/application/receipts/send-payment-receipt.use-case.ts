import {
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { GetPaymentReceiptUseCase } from './get-payment-receipt.use-case';
import { RECEIPT_EMAIL_SENDER } from '../../domain/ports/receipt-email-sender.port';
import type { ReceiptEmailSender } from '../../domain/ports/receipt-email-sender.port';
import { maskEmail } from '../../../../shared/privacy/mask-email';
import { civilDateIn } from '../../../../shared/time/civil-day';
import { noticeRecipient } from '../../../patients/domain/communication/notice-recipient';
import {
  PAYMENT_CLOCK,
  type PaymentClock,
} from '../use-cases/void-payment.use-case';

export const PATIENT_WITHOUT_EMAIL_MESSAGE =
  'El paciente no tiene un email registrado. Añádelo en su ficha para enviarle el recibo.';

export interface SendPaymentReceiptResult {
  /** Destino enmascarado (`an***@dominio`): nunca el email completo. */
  sentTo: string;
  /** DX-203: salió al email del responsable del paciente. */
  sentToResponsible: boolean;
}

/**
 * Reenvía por email el MISMO recibo que se ve y se imprime (DX-136) al email
 * actual del paciente. Sale por el outbox de DX-088: la petición no espera al
 * proveedor, y los topes de la clínica responden 429 en español.
 *
 * DX-203: el de un menor (mayoría de edad de la clínica y día civil de la
 * sede del abono) o de un paciente sin email va al responsable que recibe
 * avisos (primero el pagador), saludándolo. Lo pide recepción: no es un
 * envío automático, así que la baja de recordatorios de un paciente
 * responsable no lo frena.
 */
@Injectable()
export class SendPaymentReceiptUseCase {
  constructor(
    private readonly getReceipt: GetPaymentReceiptUseCase,
    @Inject(RECEIPT_EMAIL_SENDER)
    private readonly sender: ReceiptEmailSender,
    @Inject(PAYMENT_CLOCK) private readonly now: PaymentClock,
  ) {}

  async execute(paymentId: string): Promise<SendPaymentReceiptResult> {
    const { view, patientEmail, notice } =
      await this.getReceipt.load(paymentId);
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
      toResponsible ? recipient.name : null,
    );
    return {
      sentTo: maskEmail(recipient.email),
      sentToResponsible: toResponsible,
    };
  }
}
