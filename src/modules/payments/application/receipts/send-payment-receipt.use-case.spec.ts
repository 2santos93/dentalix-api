import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SendPaymentReceiptUseCase } from './send-payment-receipt.use-case';
import type {
  GetPaymentReceiptUseCase,
  LoadedPaymentReceipt,
} from './get-payment-receipt.use-case';
import type { ReceiptEmailSender } from '../../domain/ports/receipt-email-sender.port';
import type { PaymentReceiptView } from '../../domain/entities/payment-receipt.entity';
import type { NoticeResponsible } from '../../../patients/domain/communication/notice-recipient';

const NOW = new Date('2026-10-17T15:00:00.000Z');
const view = {
  paymentId: 'pay-1',
  reference: 'NOR-000001',
} as PaymentReceiptView;

const mother: NoticeResponsible = {
  id: 'r-1',
  name: 'Claudia Navarro',
  email: 'claudia.navarro@example.com',
  isPayer: true,
  receivesNotices: true,
  optedOut: false,
};

function loaded(
  email: string | null,
  over: {
    birthDate?: Date | null;
    responsibles?: NoticeResponsible[];
  } = {},
): LoadedPaymentReceipt {
  return {
    view,
    patientEmail: email,
    notice: {
      patient: {
        firstName: 'Ana',
        birthDate: over.birthDate ?? new Date('1990-01-01'),
        email,
        emergencyContactName: null,
      },
      responsibles: over.responsibles ?? [],
      location: { country: 'CO', timeZone: 'America/Bogota' },
    },
  };
}

function makeUseCase(result: LoadedPaymentReceipt | Error) {
  const sent: {
    to: string;
    receipt: PaymentReceiptView;
    responsibleName: string | null;
  }[] = [];
  const getReceipt = {
    load: () =>
      result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result),
  } as unknown as GetPaymentReceiptUseCase;
  const sender: ReceiptEmailSender = {
    send: (to, receipt, responsibleName) => {
      sent.push({ to, receipt, responsibleName: responsibleName ?? null });
      return Promise.resolve();
    },
  };
  return {
    uc: new SendPaymentReceiptUseCase(getReceipt, sender, () => NOW),
    sent,
  };
}

describe('SendPaymentReceiptUseCase (DX-136)', () => {
  it('envía el MISMO recibo al email del paciente y devuelve el destino enmascarado', async () => {
    const { uc, sent } = makeUseCase(loaded('ana.ruiz@example.com'));
    await expect(uc.execute('pay-1')).resolves.toEqual({
      sentTo: 'an***@example.com',
      sentToResponsible: false,
    });
    expect(sent).toEqual([
      { to: 'ana.ruiz@example.com', receipt: view, responsibleName: null },
    ]);
  });

  it('DX-203: el de un menor va al email de su responsable, y lo dice', async () => {
    const { uc, sent } = makeUseCase(
      loaded('ana.ruiz@example.com', {
        birthDate: new Date('2016-01-01'),
        responsibles: [mother],
      }),
    );
    await expect(uc.execute('pay-1')).resolves.toEqual({
      sentTo: 'cl***@example.com',
      sentToResponsible: true,
    });
    expect(sent).toEqual([
      {
        to: 'claudia.navarro@example.com',
        receipt: view,
        responsibleName: 'Claudia',
      },
    ]);
  });

  it('DX-203: un adulto sin email con responsable que recibe avisos: al responsable', async () => {
    const { uc, sent } = makeUseCase(loaded(null, { responsibles: [mother] }));
    await expect(uc.execute('pay-1')).resolves.toMatchObject({
      sentToResponsible: true,
    });
    expect(sent[0].to).toBe('claudia.navarro@example.com');
  });

  it('sin email del paciente ni responsable con email: 422 en español y no se envía nada', async () => {
    const { uc, sent } = makeUseCase(
      loaded(null, { responsibles: [{ ...mother, receivesNotices: false }] }),
    );
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
