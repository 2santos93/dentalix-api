import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SendPaymentReceiptUseCase } from './send-payment-receipt.use-case';
import type { GetPaymentReceiptUseCase } from './get-payment-receipt.use-case';
import type { ReceiptEmailSender } from '../../domain/ports/receipt-email-sender.port';
import type { PaymentReceiptView } from '../../domain/entities/payment-receipt.entity';

const view = {
  paymentId: 'pay-1',
  reference: 'NOR-000001',
} as PaymentReceiptView;

function makeUseCase(
  loaded: { view: PaymentReceiptView; patientEmail: string | null } | Error,
) {
  const sent: { to: string; receipt: PaymentReceiptView }[] = [];
  const getReceipt = {
    load: () =>
      loaded instanceof Error
        ? Promise.reject(loaded)
        : Promise.resolve(loaded),
  } as unknown as GetPaymentReceiptUseCase;
  const sender: ReceiptEmailSender = {
    send: (to, receipt) => {
      sent.push({ to, receipt });
      return Promise.resolve();
    },
  };
  return { uc: new SendPaymentReceiptUseCase(getReceipt, sender), sent };
}

describe('SendPaymentReceiptUseCase (DX-136)', () => {
  it('envía el MISMO recibo al email del paciente y devuelve el destino enmascarado', async () => {
    const { uc, sent } = makeUseCase({
      view,
      patientEmail: 'ana.ruiz@example.com',
    });
    await expect(uc.execute('pay-1')).resolves.toEqual({
      sentTo: 'an***@example.com',
    });
    expect(sent).toEqual([{ to: 'ana.ruiz@example.com', receipt: view }]);
  });

  it('sin email del paciente: 422 en español y no se envía nada', async () => {
    const { uc, sent } = makeUseCase({ view, patientEmail: null });
    await expect(uc.execute('pay-1')).rejects.toThrow(
      new UnprocessableEntityException(
        'El paciente no tiene un email registrado. Añádelo en su ficha para enviarle el recibo.',
      ),
    );
    expect(sent).toEqual([]);
  });

  it('un abono que no existe es 404', async () => {
    const { uc } = makeUseCase(
      new NotFoundException('No encontramos ese abono.'),
    );
    await expect(uc.execute('pay-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
