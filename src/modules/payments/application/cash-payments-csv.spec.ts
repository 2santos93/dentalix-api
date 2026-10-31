import { REFERENCE_CURRENCY_DIGITS } from '../../../shared/money/__fixtures__/reference-currency-digits';
import { PaymentMethod, TreatmentPlanStatus } from '@prisma/client';
import { CSV_BOM } from '../../../shared/csv/csv-cells';
import type { CashPaymentView } from '../domain/entities/cash-payment.entity';
import {
  CASH_PAYMENTS_CSV_HEADER,
  toCashPaymentsCsv,
} from './cash-payments-csv';

function row(overrides: Partial<CashPaymentView> = {}): CashPaymentView {
  return {
    id: 'p1',
    createdById: 'u1',
    paidAt: new Date('2026-10-15T17:00:00.000Z'),
    paidOn: '2026-10-15',
    amount: 150000,
    currency: 'COP',
    method: PaymentMethod.TRANSFER,
    paymentMethod: { id: 'pm-mobile', name: 'Pago móvil' },
    reference: 'ABC 123',
    notes: 'nota interna',
    location: { id: 'l1', name: 'Sede Norte' },
    patient: { id: 'pat-1', fullName: 'Ana Gómez' },
    treatmentPlan: {
      id: 'plan-1',
      status: TreatmentPlanStatus.ACCEPTED,
      createdAt: new Date('2026-09-01T15:00:00.000Z'),
    },
    openingBalance: null,
    splitId: null,
    splitLines: null,
    canVoid: false,
    registeredOn: '2026-10-15',
    registeredToday: false,
    ...overrides,
  };
}

const linesOf = (csv: string) => csv.slice(1).split('\r\n');

describe('CSV de la caja (DX-395)', () => {
  it('UTF-8 con BOM, CRLF, cabecera con medio y referencia y una línea por abono', () => {
    const csv = toCashPaymentsCsv(
      [row(), row({ id: 'p2' })],
      REFERENCE_CURRENCY_DIGITS,
    );
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const lines = linesOf(csv);
    expect(lines[0]).toBe(CASH_PAYMENTS_CSV_HEADER.join(','));
    expect(CASH_PAYMENTS_CSV_HEADER).toEqual([
      'Fecha',
      'Sede',
      'Paciente',
      'Destino',
      'Medio',
      'Referencia',
      'Moneda',
      'Importe',
    ]);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('');
  });

  it('lleva el medio de la clínica y la referencia, con los decimales de la moneda', () => {
    expect(
      linesOf(toCashPaymentsCsv([row()], REFERENCE_CURRENCY_DIGITS))[1],
    ).toBe(
      [
        '2026-10-15',
        '"Sede Norte"',
        '"Ana Gómez"',
        '"Plan del 2026-09-01"',
        '"Pago móvil"',
        '"ABC 123"',
        'COP',
        '150000',
      ].join(','),
    );
    expect(
      linesOf(
        toCashPaymentsCsv(
          [row({ currency: 'USD', amount: 10.5 })],
          REFERENCE_CURRENCY_DIGITS,
        ),
      )[1].endsWith(',USD,10.50'),
    ).toBe(true);
  });

  it('saldo migrado, sin medio ni referencia', () => {
    const line = linesOf(
      toCashPaymentsCsv(
        [
          row({
            treatmentPlan: null,
            openingBalance: { id: 'ob1', concept: 'Deuda anterior' },
            method: null,
            paymentMethod: null,
            reference: null,
          }),
        ],
        REFERENCE_CURRENCY_DIGITS,
      ),
    )[1];
    expect(line).toContain('"Saldo migrado · Deuda anterior","Sin método",""');
  });

  it('protege las fórmulas en la referencia y el nombre (inyección CSV)', () => {
    const line = linesOf(
      toCashPaymentsCsv(
        [
          row({
            reference: '=HYPERLINK("x")',
            patient: { id: 'p', fullName: '+Ana' },
          }),
        ],
        REFERENCE_CURRENCY_DIGITS,
      ),
    )[1];
    expect(line).toContain(`"'+Ana"`);
    expect(line).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('las notas internas no salen en el CSV', () => {
    expect(toCashPaymentsCsv([row()], REFERENCE_CURRENCY_DIGITS)).not.toContain(
      'nota interna',
    );
  });
});
