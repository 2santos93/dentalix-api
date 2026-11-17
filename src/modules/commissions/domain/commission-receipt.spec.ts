import { ConflictException } from '@nestjs/common';
import { PdfkitCommissionPdfRenderer } from '../infrastructure/commission-pdf.renderer';
import {
  buildReceiptContent,
  receiptContentHash,
  receiptDocumentModel,
  settlementDocumentModel,
} from './commission-receipt';
import type { SettlementDocumentSource } from './ports/commission-payment-repository.port';
import type { CommissionPaymentView } from './views';

/** PNG 1×1 opaco (una «firma» mínima con tinta). */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

/** Lo que pinta cada operador `TJ`, decodificado de WinAnsi (sin comprimir). */
function painted(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  return [...raw.matchAll(/\[([^\]]*)\] TJ/g)]
    .map((op) =>
      [...op[1].matchAll(/<([0-9a-f]*)>/g)]
        .map((hex) => Buffer.from(hex[1], 'hex').toString('latin1'))
        .join(''),
    )
    .join('\n');
}

const payment = (
  over: Partial<CommissionPaymentView> = {},
): CommissionPaymentView => ({
  id: 'p1',
  settlementId: 's1',
  currency: 'USD',
  amount: 30,
  method: 'TRANSFER',
  paidOn: '2026-11-05',
  reference: 'TRF-0042',
  location: { id: 'loc', name: 'Sede Chacao' },
  expenseId: 'e1',
  lineIds: ['l1', 'l2'],
  createdAt: new Date('2026-11-05T14:00:00Z'),
  createdBy: { userId: 'admin', name: 'Admin' },
  voidedAt: null,
  voidedBy: null,
  voidReason: null,
  receipt: {
    status: 'NONE',
    requestedAt: null,
    expiresAt: null,
    signedAt: null,
    signerName: null,
  },
  ...over,
});

function source(
  over: Partial<SettlementDocumentSource> = {},
): SettlementDocumentSource {
  return {
    clinicName: 'Clínica Sonrisa Caracas',
    header: {
      id: 's1',
      userId: 'u1',
      membershipId: 'm1',
      professionalName: 'Dra. Andrea Rivas',
      professionalEmail: 'andrea@example.com',
      period: { from: '2026-10-01', to: '2026-10-31' },
    },
    closedAt: new Date('2026-11-02T13:00:00Z'),
    basis: 'COLLECTED',
    lines: [
      {
        id: 'l1',
        kind: 'ACCRUAL',
        patientInitials: 'M. J. P.',
        catalogCode: 'D2391',
        catalogLabel: 'Resina compuesta',
        toothNumber: '16',
        day: '2026-10-14',
        currency: 'USD',
        base: 100,
        percent: 35,
        amount: 35,
        paymentId: 'p1',
      },
      {
        id: 'l2',
        kind: 'ADJUSTMENT',
        patientInitials: 'L. R.',
        catalogCode: 'D1110',
        catalogLabel: 'Profilaxis',
        toothNumber: '',
        day: null,
        currency: 'USD',
        base: -14.29,
        percent: 35,
        amount: -5,
        paymentId: 'p1',
      },
      {
        id: 'l3',
        kind: 'ACCRUAL',
        patientInitials: 'C. G.',
        catalogCode: 'D0150',
        catalogLabel: 'Evaluación',
        toothNumber: '',
        day: '2026-10-20',
        currency: 'VES',
        base: 2000,
        percent: 30,
        amount: 600,
        paymentId: null,
      },
    ],
    payments: [payment()],
    format: {
      id: 'loc',
      locale: 'es-VE',
      hourCycle: 'h12',
      timeZone: 'America/Caracas',
    },
    ...over,
  };
}

const renderer = new PdfkitCommissionPdfRenderer({ compress: false });
const NOW = new Date('2026-11-10T12:00:00Z');

describe('PDF de la liquidación (DX-464)', () => {
  it('iniciales (nunca el nombre), procedimiento, fecha, base, %, total por moneda y estado', async () => {
    const model = settlementDocumentModel(source(), NOW);
    expect(model.facts).toContainEqual({
      label: 'Estado',
      value: 'Pagada parcialmente',
    });
    expect(model.sections.map((s) => s.title)).toEqual([
      'Moneda: USD',
      'Moneda: VES',
    ]);
    const usd = model.sections[0];
    expect(usd.rows[0]).toMatchObject({
      patient: 'M. J. P.',
      procedure: 'D2391 Resina compuesta · diente 16',
    });
    expect(usd.rows[1].procedure).toContain('(ajuste)');
    expect(usd.totals.map((t) => t.label)).toEqual([
      'Devengado',
      'Ajustes de liquidaciones anteriores',
      'Deducciones',
      'Total USD',
      'Pagado',
      'Pendiente',
    ]);
    const text = painted(await renderer.render(model));
    expect(text).toContain('Liquidación de honorarios');
    expect(text).toContain('M. J. P.');
    expect(text).toContain('Dra. Andrea Rivas');
    expect(text).not.toMatch(/María|Pérez/);
    expect(text).toMatch(/Página 1 de 1/);
  });

  it('es determinista: la misma entrada da los mismos bytes', async () => {
    const a = await renderer.render(settlementDocumentModel(source(), NOW));
    const b = await renderer.render(settlementDocumentModel(source(), NOW));
    expect(a.equals(b)).toBe(true);
  });

  it('una sede sin formato regional: 409 LOCATION_LOCALE_REQUIRED (DX-354)', () => {
    expect(() =>
      settlementDocumentModel(
        source({
          format: { id: 'loc', locale: null, hourCycle: null, timeZone: null },
        }),
        NOW,
      ),
    ).toThrow(ConflictException);
  });
});

describe('Recibo y conformidad (DX-464)', () => {
  it('la foto del recibo lleva solo las líneas del pago y su huella es estable', () => {
    const content = buildReceiptContent(source(), payment());
    expect(content.lines.map((l) => l.patientInitials)).toEqual([
      'M. J. P.',
      'L. R.',
    ]);
    expect(content.payment).toMatchObject({
      amount: 30,
      currency: 'USD',
      reference: 'TRF-0042',
      locationName: 'Sede Chacao',
    });
    // Ida y vuelta por JSON (jsonb): la misma huella.
    const again = JSON.parse(JSON.stringify(content)) as typeof content;
    expect(receiptContentHash(again)).toBe(receiptContentHash(content));
  });

  it('el PDF firmado lleva fecha, IP, navegador, firma y huellas', async () => {
    const content = buildReceiptContent(source(), payment());
    const model = receiptDocumentModel(
      content,
      {
        signerName: 'Andrea Rivas',
        signature: PNG,
        signedAt: new Date('2026-11-06T15:30:00Z'),
        ipAddress: '190.202.1.10',
        userAgent: 'Mozilla/5.0',
        contentHash: 'a'.repeat(64),
        receiptHash: 'b'.repeat(64),
      },
      'America/Caracas',
      NOW,
    );
    expect(model.title).toContain('Recibido conforme');
    const text = painted(await renderer.render(model));
    for (const fragment of [
      'Recibido conforme',
      'Andrea Rivas',
      '190.202.1.10',
      'a'.repeat(64),
      'b'.repeat(64),
      'TRF-0042',
    ]) {
      expect(text).toContain(fragment);
    }
  });
});
