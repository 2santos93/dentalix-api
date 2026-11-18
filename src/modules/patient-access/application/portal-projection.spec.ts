import {
  PORTAL_ACCOUNT_KEYS,
  PORTAL_QUOTE_KEYS,
  keysOutside,
} from '../../../../test/support/patient-portal-keys';
import { staffQuote, staffStatement } from './__fixtures__/staff-documents';
import { toPortalAccount, toPortalQuote } from './portal-projection';

const INTERNAL = [
  '203.0.113.7',
  'Mozilla',
  'Recepción Ana',
  'nota interna del vencido',
  'rep-1',
  'item-9',
  'sr-1',
  'nota clínica interna',
  'cat-1',
  'user-staff',
  'user-admin',
  'Admin Clínica',
  'error de caja interno',
  'batch-1',
  'pm-1',
  'split-1',
  'pay-9',
  'c@x.example',
  'futureSecret',
  'pal-interno-1',
];

describe('proyección del portal (DX-101): lista blanca', () => {
  it('el presupuesto solo lleva claves de la lista blanca, aunque el del personal traiga más', () => {
    const out = toPortalQuote(staffQuote());
    expect(keysOutside(out, PORTAL_QUOTE_KEYS)).toEqual([]);
    const json = JSON.stringify(out);
    for (const secret of INTERNAL) expect(json).not.toContain(secret);
    // De la aceptación, solo quién firmó, la firma y cuándo.
    expect(out.acceptance).toEqual({
      signerName: 'Carmen Rondón',
      signature: 'data:image/png;base64,iVBORw0KGgo=',
      acceptedAt: new Date('2026-11-18T15:00:00.000Z'),
    });
    // Lo que el paciente imprime sigue igual.
    expect(out.items[0]).toMatchObject({
      procedure: 'Resina',
      subtotal: 80.25,
    });
    expect(out.totals[0]).toMatchObject({ net: 80.25, agreementSaving: 9.75 });
  });

  it('el estado de cuenta solo lleva claves de la lista blanca, con los mismos importes', () => {
    const out = toPortalAccount(staffStatement());
    expect(keysOutside(out, PORTAL_ACCOUNT_KEYS)).toEqual([]);
    const json = JSON.stringify(out);
    for (const secret of INTERNAL) expect(json).not.toContain(secret);
    expect(out.summary[0]).toMatchObject({ paid: 100.15, balance: 150.35 });
    expect(out.movements[0]).toEqual({
      paidAt: new Date('2026-11-18T15:00:00.000Z'),
      paidOn: '2026-07-01',
      amount: 100.15,
      currency: 'USD',
      method: 'CASH',
      paymentMethodName: 'Efectivo',
      reference: 'REF-1',
      externalInvoiceNumber: null,
      splitLines: null,
      receiptNumber: 'R-0001',
      locationName: 'Sede Altamira',
      treatmentPlanId: 'plan-1',
      openingBalanceId: null,
      voided: true,
      voidedAt: new Date('2026-11-18T15:00:00.000Z'),
    });
    expect(out.addressee).toEqual({ kind: 'PATIENT', name: 'Carmen Rondón' });
  });

  it('el detector de claves de verdad falla con una clave nueva', () => {
    expect(
      keysOutside(
        { items: [{ toothNumber: '1', secret: 1 }] },
        PORTAL_QUOTE_KEYS,
      ),
    ).toEqual(['items[].secret']);
  });
});
