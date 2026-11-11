import { UnprocessableEntityException } from '@nestjs/common';
import { SendPaymentReceiptSummaryUseCase } from './send-payment-receipt-summary.use-case';
import { PATIENT_WITHOUT_EMAIL_MESSAGE } from './send-payment-receipt.use-case';
import type {
  GetPaymentReceiptSummaryUseCase,
  LoadedReceiptSummary,
} from './get-payment-receipt-summary.use-case';
import type {
  PaymentReceiptSummaryRepository,
  ReceiptSummaryRecipientSource,
} from '../../domain/ports/payment-receipt-summary-repository.port';
import type { ReceiptSummaryEmailSender } from '../../domain/ports/receipt-summary-email-sender.port';
import {
  RECEIPT_SUMMARY_EMPTY_MESSAGE,
  type PaymentReceiptSummaryView,
  type ReceiptSummarySourceItem,
} from '../../domain/receipt-summary';
import type { NoticeResponsible } from '../../../patients/domain/communication/notice-recipient';

const NOW = new Date('2026-11-05T14:00:00.000Z');
const view = {
  patient: { id: 'p-1', fullName: 'Luis Contreras' },
} as PaymentReceiptSummaryView;

const mother: NoticeResponsible = {
  id: 'r-1',
  name: 'Yusmary Contreras',
  email: 'yusmary.contreras@example.com',
  isPayer: true,
  receivesNotices: true,
  optedOut: false,
};

const receiptAt = (
  locationId: string,
  issuedAt: string,
): ReceiptSummarySourceItem => ({
  paymentId: `pay-${locationId}`,
  locationId,
  receiptNumber: 'CCS-000001',
  issuedAt: new Date(issuedAt),
  issuedOn: issuedAt.slice(0, 10),
  locationName: 'Sede',
  voided: false,
  voidReason: null,
  parts: [],
});

function recipientSource(
  email: string | null,
  over: { birthDate?: Date; responsibles?: NoticeResponsible[] } = {},
): ReceiptSummaryRecipientSource {
  return {
    patientEmail: email,
    notice: {
      patient: {
        firstName: 'Luis',
        birthDate: over.birthDate ?? new Date('1988-03-14'),
        email,
        emergencyContactName: null,
      },
      responsibles: over.responsibles ?? [],
      settings: { timeZone: 'America/Caracas', majorityAge: 18 },
    },
  };
}

function makeUseCase(
  items: ReceiptSummarySourceItem[],
  recipient: ReceiptSummaryRecipientSource,
) {
  const sent: { to: string; locationId: string; responsible: string | null }[] =
    [];
  const recipientCalls: string[] = [];
  const getSummary = {
    load: (): Promise<LoadedReceiptSummary> => Promise.resolve({ view, items }),
  } as unknown as GetPaymentReceiptSummaryUseCase;
  const repo: PaymentReceiptSummaryRepository = {
    find: () => Promise.reject(new Error('no se usa')),
    recipient: (_patientId, locationId) => {
      recipientCalls.push(locationId);
      return Promise.resolve(recipient);
    },
  };
  const sender: ReceiptSummaryEmailSender = {
    send: (to, _summary, locationId, responsible) => {
      sent.push({ to, locationId, responsible });
      return Promise.resolve();
    },
  };
  return {
    uc: new SendPaymentReceiptSummaryUseCase(
      getSummary,
      repo,
      sender,
      () => NOW,
    ),
    sent,
    recipientCalls,
  };
}

const PERIOD = { from: '2026-10-01', to: '2026-10-31' };

describe('SendPaymentReceiptSummaryUseCase (DX-401)', () => {
  it('lo encola al email del paciente con el formato de la sede del último recibo', async () => {
    const { uc, sent, recipientCalls } = makeUseCase(
      [
        receiptAt('loc-late', '2026-10-25T15:00:00.000Z'),
        receiptAt('loc-early', '2026-10-03T15:00:00.000Z'),
      ],
      recipientSource('luis.contreras@example.com'),
    );
    await expect(uc.execute('p-1', PERIOD)).resolves.toEqual({
      sentTo: 'lu***@example.com',
      sentToResponsible: false,
    });
    expect(recipientCalls).toEqual(['loc-late']);
    expect(sent).toEqual([
      {
        to: 'luis.contreras@example.com',
        locationId: 'loc-late',
        responsible: null,
      },
    ]);
  });

  it('DX-203: un menor va a su responsable que recibe avisos', async () => {
    const { uc, sent } = makeUseCase(
      [receiptAt('loc-1', '2026-10-03T15:00:00.000Z')],
      recipientSource('luis.contreras@example.com', {
        birthDate: new Date('2015-06-01'),
        responsibles: [mother],
      }),
    );
    await expect(uc.execute('p-1', PERIOD)).resolves.toEqual({
      sentTo: 'yu***@example.com',
      sentToResponsible: true,
    });
    expect(sent[0]).toMatchObject({
      to: 'yusmary.contreras@example.com',
      responsible: 'Yusmary',
    });
  });

  it('sin email del paciente ni de un responsable: 422 en español', async () => {
    const { uc, sent } = makeUseCase(
      [receiptAt('loc-1', '2026-10-03T15:00:00.000Z')],
      recipientSource(null),
    );
    const run = uc.execute('p-1', PERIOD);
    await expect(run).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(run).rejects.toThrow(PATIENT_WITHOUT_EMAIL_MESSAGE);
    expect(sent).toEqual([]);
  });

  it('sin abonos en el período: 422 «No hay abonos en ese periodo» y no se envía nada', async () => {
    const { uc, sent, recipientCalls } = makeUseCase(
      [],
      recipientSource('luis.contreras@example.com'),
    );
    const run = uc.execute('p-1', PERIOD);
    await expect(run).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(run).rejects.toThrow(RECEIPT_SUMMARY_EMPTY_MESSAGE);
    expect(recipientCalls).toEqual([]);
    expect(sent).toEqual([]);
  });
});
