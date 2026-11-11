import { receiptSummaryEmailVars } from './receipt-summary-email-vars';
import { renderEmail } from '../../../notifications/email/application/templates/templates';
import { regionalFormat } from '../../../../shared/format/regional-format';
import {
  RECEIPT_SUMMARY_NOTICE,
  type PaymentReceiptSummaryView,
} from '../../domain/receipt-summary';

const fmt = regionalFormat({ locale: 'es-VE', hourCycle: 'h12' });
const brand = {
  clinicName: 'Clínica Ávila',
  logoUrl: null,
  primaryColor: null,
};

const summary: PaymentReceiptSummaryView = {
  patient: {
    id: 'p-1',
    fullName: 'María Fernanda Rondón',
    documentMasked: '*****5678',
    documentTypeName: 'Cédula',
    patientCode: '1042',
  },
  clinic: {
    name: 'Clínica Ávila',
    legalName: 'Odontología Ávila C.A.',
    taxId: 'J-12345678-9',
    address: null,
  },
  from: '2026-10-01',
  to: '2026-10-31',
  generatedAt: '2026-11-05T14:00:00.000Z',
  restrictedToLocations: false,
  receipts: [
    {
      paymentId: 'pay-1',
      receiptNumber: 'CCS-000010',
      issuedOn: '2026-10-02',
      locationName: 'Sede Chacao',
      methodLabel: 'Efectivo',
      amount: 40,
      currency: 'USD',
      voided: true,
      voidReason: 'Cobro duplicado',
    },
    {
      paymentId: 'pay-2',
      receiptNumber: 'ALT-000004',
      issuedOn: '2026-10-20',
      locationName: 'Sede Altamira',
      methodLabel: 'Pago móvil',
      amount: 1800,
      currency: 'VES',
      voided: false,
      voidReason: null,
    },
    {
      paymentId: 'pay-3',
      receiptNumber: 'ALT-000005',
      issuedOn: '2026-10-21',
      locationName: 'Sede Altamira',
      methodLabel: 'Zelle',
      amount: 150,
      currency: 'USD',
      voided: false,
      voidReason: null,
    },
  ],
  totals: [
    { currency: 'USD', amount: 150, count: 1 },
    { currency: 'VES', amount: 1800, count: 1 },
  ],
  voidedCount: 1,
  notice: RECEIPT_SUMMARY_NOTICE,
};

describe('email del resumen de abonos (DX-401)', () => {
  it('las variables salen de la vista, con fechas e importes de la sede', () => {
    const vars = receiptSummaryEmailVars(summary, fmt, { VES: 'Bs.' });
    expect(vars).toMatchObject({
      patientName: 'María Fernanda Rondón',
      patientDocLabel: 'Cédula *****5678',
      periodLabel: `${fmt.civilDate('2026-10-01')} al ${fmt.civilDate('2026-10-31')}`,
      fiscalLine: 'Odontología Ávila C.A. · Id. fiscal J-12345678-9',
      voidedCount: 1,
      notice: RECEIPT_SUMMARY_NOTICE,
    });
    expect(vars.lines).toHaveLength(3);
    expect(vars.lines[0]).toMatchObject({
      receiptNumber: 'CCS-000010',
      voided: true,
    });
    expect(vars.lines[1].amountLabel).toContain('Bs.');
    expect(vars.totalLabels).toHaveLength(2);
    expect(vars.totalLabels[0]).toContain('USD');
    expect(vars.totalLabels[1]).toContain('Bs.');
  });

  it('el email lista cada recibo, marca el anulado, da un total por moneda y el aviso', () => {
    const email = renderEmail(
      'payment-receipt-summary',
      receiptSummaryEmailVars(summary, fmt, null),
      brand,
    );
    expect(email.subject).toContain('Resumen de abonos del');
    expect(email.subject).toContain('Clínica Ávila');
    expect(email.text).toContain('Hola, María Fernanda Rondón');
    expect(email.text).toContain('Documento: Cédula *****5678');
    expect(email.text).toMatch(/Recibo N\.º CCS-000010 .*\(ANULADO\)/);
    expect(email.text).toMatch(/Recibo N\.º ALT-000004 .*Pago móvil/);
    expect(email.text).toMatch(/Total abonado: .*USD.* · .*VES/);
    expect(email.text).toContain('1 recibo anulado: no suma');
    expect(email.text).toContain(RECEIPT_SUMMARY_NOTICE);
    expect(email.html).not.toContain('<a href');
  });

  it('DX-203: al responsable lo saluda a él y nombra al paciente', () => {
    const email = renderEmail(
      'payment-receipt-summary',
      {
        ...receiptSummaryEmailVars(summary, fmt, null),
        responsibleName: 'Yusmary',
      },
      brand,
    );
    expect(email.text).toContain('Hola, Yusmary');
    expect(email.text).toContain(
      'Te enviamos el resumen de los abonos de María Fernanda Rondón',
    );
  });

  it('sin datos fiscales: «Datos fiscales pendientes»; todo anulado: sin total vigente', () => {
    const email = renderEmail(
      'payment-receipt-summary',
      receiptSummaryEmailVars(
        {
          ...summary,
          clinic: { ...summary.clinic, taxId: null },
          totals: [],
        },
        fmt,
        null,
      ),
      brand,
    );
    expect(email.text).toContain('Datos fiscales pendientes');
    expect(email.text).toContain(
      'Total abonado: sin abonos vigentes en el período',
    );
  });
});
