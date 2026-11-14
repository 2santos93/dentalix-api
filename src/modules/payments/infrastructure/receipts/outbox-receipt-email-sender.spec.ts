import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { renderEmail } from '../../../notifications/email/application/templates/templates';
import type { PaymentReceiptEmailVars } from '../../../notifications/email/domain/email-message';

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

/**
 * DX-517-bis: el MISMO importe sale igual en la pantalla, el papel y el email
 * de un recibo de una sede con locale distinto de `es`. Pantalla y papel son
 * `PaymentReceiptDocument` de la web, que lee estos mismos vectores
 * (`receipt-format.cases.json`, copia byte a byte en los dos repos): aquí se
 * comprueba que el email ENVIADO (plantilla renderizada) dice esas cadenas.
 */
describe('DX-517-bis · pantalla, papel y email dicen el mismo importe (en-US)', () => {
  interface MoneyCase {
    locale: string;
    op: string;
    args: [number, string, Record<string, string>];
    expected: string;
  }
  const CASES = JSON.parse(
    readFileSync(
      join(__dirname, '../../../../shared/format/receipt-format.cases.json'),
      'utf8',
    ),
  ) as MoneyCase[];
  const vector = (amount: number, currency: string, texts: object) => {
    const found = CASES.find(
      (c) =>
        c.locale === 'en-US' &&
        c.op === 'moneyWithCode' &&
        c.args[0] === amount &&
        c.args[1] === currency &&
        JSON.stringify(c.args[2]) === JSON.stringify(texts),
    );
    if (!found) throw new Error(`Sin vector en-US ${amount} ${currency}`);
    return found.expected;
  };

  it('VES con el texto «Bs.» congelado y saldo en USD, con la región en-US del recibo', async () => {
    const frozen = buildReceiptSnapshot(
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
          amount: 1234.5,
          currency: 'VES',
          method: 'CASH',
          paidAt: new Date('2026-10-27T17:00:00.000Z'),
          paidOn: '2026-10-27',
        },
        plan: {
          id: 'plan-1',
          optionLabel: null,
          createdAt: new Date('2026-09-01T14:00:00.000Z'),
        },
        planBalance: {
          currency: 'USD',
          billable: 2000,
          paid: 765.5,
          balance: 1234.5,
        },
        cashier: { id: 'u-1', fullName: 'Recepción Demo' },
        currencyTexts: { VES: 'Bs.' },
      },
      NO_LOCAL_NAMES,
    );
    const { sender, requested, enqueued } = setup([]);
    await sender.send('carolina@example.com', {
      ...receipt,
      regional: {
        timeZone: 'America/New_York',
        locale: 'en-US',
        hourCycle: 'h12',
      },
      snapshot: {
        ...frozen,
        patient: receiptPatientView(frozen, NO_LOCAL_NAMES),
      },
    });
    expect(requested).toEqual([]);
    const amount = vector(1234.5, 'VES', { VES: 'Bs.' });
    const balance = vector(1234.5, 'USD', {});
    expect(amount).toBe('Bs.\u00a01,234.50');
    const vars = enqueued[0].vars as unknown as PaymentReceiptEmailVars;
    expect(vars.amountLabel).toBe(amount);
    expect(vars.balanceLabel).toBe(balance);
    const email = renderEmail('payment-receipt', vars, null);
    expect(email.text).toContain(`Valor: ${amount} ·`);
    expect(email.text).toContain(`: ${balance}`);
    expect(email.text).not.toContain('VES');
    expect(email.html).toContain(amount);
    expect(email.html).toContain(balance);
  });
});
