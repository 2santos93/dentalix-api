import { ConflictException } from '@nestjs/common';
import type { EmailOutbox } from '../../../notifications/email/application/email-outbox.service';
import type { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  buildReceiptSnapshot,
  receiptPatientView,
} from '../../domain/receipt-snapshot';
import { NO_LOCAL_NAMES } from '../../../document-type-names/__fixtures__/fixed-document-type-names.reader';
import type { PaymentReceiptView } from '../../domain/entities/payment-receipt.entity';
import { OutboxReceiptEmailSender } from './outbox-receipt-email-sender';

const TENANT_ID = 't1';

const stored = buildReceiptSnapshot(
  {
    clinic: {
      name: 'Clínica Demo',
      legalName: null,
      taxId: null,
      address: null,
    },
    location: { id: 'loc-recibo', name: 'Sede Norte', address: null },
    patient: {
      id: 'pat-1',
      firstName: 'Carolina',
      lastName: 'Duque',
      docType: 'NATIONAL_ID',
      docTypeLabel: null,
      docNumber: '1012345678',
    },
    payment: {
      id: 'pay-1',
      amount: 150,
      currency: 'USD',
      method: 'CASH',
      paidAt: new Date('2026-10-27T17:00:00.000Z'),
      paidOn: '2026-10-27',
    },
    plan: null,
    planBalance: null,
    cashier: { id: 'u-1', fullName: 'Recepción Demo' },
  },
  NO_LOCAL_NAMES,
);
const snapshot = {
  ...stored,
  patient: receiptPatientView(stored, NO_LOCAL_NAMES),
};

const receipt: PaymentReceiptView = {
  paymentId: 'pay-1',
  reference: 'NOR-000123',
  seriesPrefix: 'NOR',
  number: 123,
  legacy: false,
  issuedAt: new Date('2026-10-27T17:00:05.000Z'),
  voided: false,
  voidedAt: null,
  voidReason: null,
  exchangeRate: null,
  split: null,
  regional: null,
  snapshot,
};

interface LocationRow {
  id: string;
  timeZone: string | null;
  locale: string | null;
  hourCycle: string | null;
}

/**
 * Un `PrismaService` falso: `runWithTenant` pasa un `tx` cuyo `$queryRaw`
 * devuelve las sedes pedidas (el segundo valor de la plantilla son los ids)
 * y apunta qué ids se pidieron.
 */
function setup(rows: LocationRow[]) {
  const requested: string[][] = [];
  const tx = {
    $queryRaw: (_sql: TemplateStringsArray, ...values: unknown[]) => {
      const ids = values[1] as string[];
      requested.push(ids);
      return Promise.resolve(rows.filter((row) => ids.includes(row.id)));
    },
  };
  const prisma = {
    runWithTenant: <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as PrismaService;
  const enqueued: { vars: Record<string, unknown> }[] = [];
  const outbox = {
    assertWithinQuota: () => Promise.resolve(),
    enqueue: (input: { vars: Record<string, unknown> }) => {
      enqueued.push(input);
      return Promise.resolve();
    },
  } as unknown as EmailOutbox;
  const tenantContext = {
    getTenantId: () => TENANT_ID,
  } as unknown as TenantContextService;
  const sender = new OutboxReceiptEmailSender(outbox, tenantContext, prisma);
  return { sender, requested, enqueued };
}

describe('OutboxReceiptEmailSender · formato de la sede del recibo (G1-B)', () => {
  it('formats with the receipt location, read through resolveLocationRegional', async () => {
    const { sender, requested, enqueued } = setup([
      {
        id: 'loc-recibo',
        timeZone: 'America/New_York',
        locale: 'en-US',
        hourCycle: 'h12',
      },
      {
        id: 'loc-principal',
        timeZone: 'Europe/Madrid',
        locale: 'es-ES',
        hourCycle: 'h23',
      },
    ]);
    await sender.send('carolina@example.com', receipt);
    expect(requested).toEqual([['loc-recibo']]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].vars).toMatchObject({
      paidOnLabel: '10/27/2026',
      amountLabel: 'USD\u00a0150.00',
    });
  });

  it('a receipt location without clock is 409 LOCATION_LOCALE_REQUIRED and enqueues nothing', async () => {
    const { sender, enqueued } = setup([
      {
        id: 'loc-recibo',
        timeZone: 'America/New_York',
        locale: 'en-US',
        hourCycle: null,
      },
    ]);
    const error = await sender
      .send('carolina@example.com', receipt)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'LOCATION_LOCALE_REQUIRED',
      locationId: 'loc-recibo',
    });
    expect(enqueued).toHaveLength(0);
  });

  describe('región congelada del recibo (DX-521, R6 y PF4)', () => {
    const CARACAS = {
      timeZone: 'America/Caracas',
      locale: 'es-VE',
      hourCycle: 'h23',
    } as const;
    const voidedAtNight = {
      voided: true,
      voidedAt: new Date('2026-11-02T01:30:00.000Z'),
      voidReason: 'Cobro duplicado',
    };

    it('con `regional` en el recibo formatea con ella y no lee la sede', async () => {
      // La sede de hoy dice otra cosa: la del recibo manda.
      const { sender, requested, enqueued } = setup([
        {
          id: 'loc-recibo',
          timeZone: 'Europe/Madrid',
          locale: 'es-ES',
          hourCycle: 'h23',
        },
      ]);
      await sender.send('carolina@example.com', {
        ...receipt,
        ...voidedAtNight,
        regional: CARACAS,
      });
      expect(requested).toEqual([]);
      // 01:30 UTC del 2 es todavía el 1 en Caracas.
      expect(enqueued[0].vars).toMatchObject({
        paidOnLabel: '27/10/2026',
        amountLabel: 'USD\u00a0150,00',
        voided: { dateLabel: '01/11/2026', reason: 'Cobro duplicado' },
      });
    });

    it('un recibo con `regional` no da 409 aunque la sede de hoy no tenga reloj', async () => {
      const { sender, enqueued } = setup([
        {
          id: 'loc-recibo',
          timeZone: 'America/New_York',
          locale: 'en-US',
          hourCycle: null,
        },
      ]);
      await sender.send('carolina@example.com', {
        ...receipt,
        regional: CARACAS,
      });
      expect(enqueued).toHaveLength(1);
    });

    it.each([
      ['zona', { ...CARACAS, timeZone: 'Mars/Olympus' }],
      ['locale', { ...CARACAS, locale: 'zz-ZZ-not-a-tag-!!' }],
    ])(
      'PF4: una región con %s que este runtime no reconoce sigue por la sede (y su 409)',
      async (_label, regional) => {
        const ok = setup([
          {
            id: 'loc-recibo',
            timeZone: 'America/New_York',
            locale: 'en-US',
            hourCycle: 'h12',
          },
        ]);
        await ok.sender.send('carolina@example.com', { ...receipt, regional });
        expect(ok.requested).toEqual([['loc-recibo']]);
        expect(ok.enqueued[0].vars).toMatchObject({
          paidOnLabel: '10/27/2026',
        });

        const broken = setup([
          {
            id: 'loc-recibo',
            timeZone: 'America/New_York',
            locale: 'en-US',
            hourCycle: null,
          },
        ]);
        const error = await broken.sender
          .send('carolina@example.com', { ...receipt, regional })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConflictException);
        expect(broken.enqueued).toHaveLength(0);
      },
    );
  });
});
