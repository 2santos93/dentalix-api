import { DiscountReason } from '@prisma/client';
import {
  DISCOUNT_REPORT_CSV_HEADER,
  toDiscountReportCsv,
} from './discount-report-csv';
import type { DiscountReportRowView } from './use-cases/get-discount-report.use-case';

const row: DiscountReportRowView = {
  itemId: 'i1',
  planId: 'p1',
  planStatus: 'PRESENTED',
  planOptionLabel: 'Opción A',
  planCreatedAt: new Date('2026-10-01T15:00:00Z'),
  planCreatedOn: '2026-10-01',
  patientId: 'pa1',
  patientName: '=HYPERLINK("http://x")',
  toothNumber: '36',
  procedure: 'Corona "zirconio"',
  currency: 'EUR',
  catalogPrice: null,
  referenceCurrency: null,
  referencePriceInPlan: null,
  basePriceInPlan: null,
  rate: null,
  price: 450,
  priceReduction: 0,
  itemDiscount: 67.5,
  discount: 67.5,
  percent: 15,
  reason: DiscountReason.OTHER,
  reasonNote: '+cmd\nmalicioso',
  discountById: 'u1',
  discountByName: '@admin',
  discountAt: new Date('2026-10-02T15:00:00Z'),
  discountOn: '2026-10-02',
  locationId: 'l1',
  locationName: ' -Sede',
  priceSource: 'CATALOG',
  agreementName: null,
  basePrice: null,
  agreementReduction: 0,
  agreementPercent: 0,
  agreementAssignedById: null,
  agreementAssignedByName: null,
  createdById: 'u1',
  createdByName: '=creador',
};

/** Precio de catálogo y las cinco columnas de importes y % (sin las de DX-513-bis). */
const amounts = (cells: string[]) => [cells[8], ...cells.slice(13, 18)];

describe('CSV del informe de descuentos (DX-204)', () => {
  it('UTF-8 con BOM, CRLF, cabecera y una línea por ítem', () => {
    const csv = toDiscountReportCsv([row]);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(DISCOUNT_REPORT_CSV_HEADER.join(','));
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
  });

  it('protege contra la inyección de fórmulas y escapa comillas', () => {
    const line = toDiscountReportCsv([row]).slice(1).split('\r\n')[1];
    expect(line).toBe(
      [
        '2026-10-02',
        `"'=HYPERLINK(""http://x"")"`,
        '"Plan del 2026-10-01 · Opción A"',
        'Presentado',
        '"36"',
        '"Corona ""zirconio"""',
        'EUR',
        '',
        '',
        '',
        '',
        '',
        '',
        '450.00',
        '0.00',
        '67.50',
        '67.50',
        '15.00',
        '"Otro"',
        `"'+cmd malicioso"`,
        `"'@admin"`,
        `"' -Sede"`,
        '""',
        '',
        '0.00',
        '""',
        `"'=creador"`,
      ].join(','),
    );
  });

  it('importes en la unidad de la moneda: RSD sin decimales, EUR a céntimos', () => {
    const usd: DiscountReportRowView = {
      ...row,
      currency: 'RSD',
      price: 123457,
      itemDiscount: 9259,
      discount: 9259,
      percent: 7.5,
    };
    const [, eurLine, usdLine] = toDiscountReportCsv([row, usd])
      .slice(1)
      .split('\r\n');
    expect(amounts(eurLine.split(','))).toEqual([
      '',
      '450.00',
      '0.00',
      '67.50',
      '67.50',
      '15.00',
    ]);
    expect(amounts(usdLine.split(','))).toEqual([
      '',
      '123457',
      '0',
      '9259',
      '9259',
      '7.50',
    ]);
  });

  it('la rebaja de precio frente al catálogo sale con su importe (SEC-041)', () => {
    const reduced: DiscountReportRowView = {
      ...row,
      currency: 'RSD',
      catalogPrice: 1000000,
      price: 500000,
      priceReduction: 500000,
      itemDiscount: 0,
      discount: 500000,
      percent: 50,
    };
    const line = toDiscountReportCsv([reduced]).slice(1).split('\r\n')[1];
    expect(amounts(line.split(','))).toEqual([
      '1000000',
      '500000',
      '500000',
      '0',
      '500000',
      '50.00',
    ]);
    expect(amounts([...DISCOUNT_REPORT_CSV_HEADER])).toEqual([
      'Precio de catálogo',
      'Precio',
      'Rebaja de precio',
      'Descuento del ítem',
      'Descuento total',
      'Descuento (%)',
    ]);
  });

  it('el diente también va entre comillas y protegido (dato heredado sin validar)', () => {
    const line = toDiscountReportCsv([{ ...row, toothNumber: '=1+1' }])
      .slice(1)
      .split('\r\n')[1];
    expect(line).toContain(`,"'=1+1",`);
  });

  it('SEC-047: la rebaja de convenio sale aparte, con quién asignó el convenio y quién creó el ítem', () => {
    const agreed: DiscountReportRowView = {
      ...row,
      currency: 'RSD',
      priceSource: 'AGREEMENT_PERCENT',
      agreementName: 'Cortesía socios',
      basePrice: 2000000,
      catalogPrice: 0,
      price: 0,
      priceReduction: 0,
      itemDiscount: 0,
      discount: 0,
      percent: 0,
      agreementReduction: 2000000,
      agreementPercent: 100,
      agreementAssignedById: 'u9',
      agreementAssignedByName: 'Admin Clínica',
      createdByName: 'Dr. Pérez',
      discountById: null,
      discountByName: null,
      reason: null,
      reasonNote: null,
    };
    const cells = toDiscountReportCsv([agreed])
      .slice(1)
      .split('\r\n')[1]
      .split(',');
    // B5: una línea solo de convenio dice «Convenio …» como motivo y lleva el
    // autor real (quien asignó el convenio), no un descuento sin autor.
    expect(cells[18]).toBe('"Convenio Cortesía socios"');
    expect(cells[20]).toBe('"Admin Clínica"');
    expect(cells.slice(22)).toEqual([
      '"Cortesía socios"',
      '2000000',
      '2000000',
      '"Admin Clínica"',
      '"Dr. Pérez"',
    ]);
    expect(DISCOUNT_REPORT_CSV_HEADER.slice(22)).toEqual([
      'Convenio',
      'Precio sin convenio',
      'Rebaja por convenio',
      'Convenio asignado por',
      'Ítem creado por',
    ]);
  });

  it('B5: sin quien asignó el convenio, el autor es quien creó el ítem', () => {
    const agreed: DiscountReportRowView = {
      ...row,
      reason: null,
      reasonNote: null,
      itemDiscount: 0,
      discount: 0,
      agreementName: 'Surco',
      basePrice: 100,
      agreementReduction: 10,
      agreementAssignedByName: null,
      createdByName: 'Dr. Pérez',
      discountByName: null,
    };
    const cells = toDiscountReportCsv([agreed])
      .slice(1)
      .split('\r\n')[1]
      .split(',');
    expect(cells[20]).toBe('"Dr. Pérez"');
  });

  it('DX-488: con los decimales de la pantalla, no los del redondeo: RSD con céntimos guardados los conserva', () => {
    const cents: DiscountReportRowView = {
      ...row,
      currency: 'RSD',
      price: 123.45,
      itemDiscount: 9,
      discount: 9,
      percent: 7.29,
    };
    const line = toDiscountReportCsv([cents]).slice(1).split('\r\n')[1];
    expect(amounts(line.split(','))).toEqual([
      '',
      '123.45',
      '0',
      '9',
      '9',
      '7.29',
    ]);
  });

  it('DX-513-bis: el precio de catálogo va en SU moneda, con la referencia en la del plan y la tasa congelada (C2)', () => {
    const converted: DiscountReportRowView = {
      ...row,
      currency: 'VES',
      catalogPrice: 4.5,
      referenceCurrency: 'USD',
      referencePriceInPlan: 3960,
      basePriceInPlan: 3960,
      rate: {
        fromPerBase: 1,
        toPerBase: 880,
        source: 'MANUAL',
        rateDate: '2026-11-06',
      },
      price: 3900,
      priceReduction: 60,
      itemDiscount: 0,
      discount: 60,
      percent: 1.52,
    };
    const cells = toDiscountReportCsv([converted])
      .slice(1)
      .split('\r\n')[1]
      .split(',');
    expect(DISCOUNT_REPORT_CSV_HEADER.slice(6, 14)).toEqual([
      'Moneda',
      'Moneda del catálogo',
      'Precio de catálogo',
      'Precio de catálogo en la moneda del plan',
      'Tasa (por 1 USD: origen / plan)',
      'Fuente de la tasa',
      'Fecha de la tasa',
      'Precio',
    ]);
    expect(cells.slice(6, 16)).toEqual([
      'VES',
      'USD',
      '4.50',
      '3960.00',
      '1 / 880',
      'Manual',
      '2026-11-06',
      '3900.00',
      '60.00',
      '0.00',
    ]);
  });

  it('DX-513-bis: un ítem anterior entre monedas no inventa la referencia en la moneda del plan', () => {
    const legacy: DiscountReportRowView = {
      ...row,
      currency: 'USD',
      catalogPrice: 3600,
      referenceCurrency: 'VES',
      price: 80,
      itemDiscount: 8,
      discount: 8,
    };
    const cells = toDiscountReportCsv([legacy])
      .slice(1)
      .split('\r\n')[1]
      .split(',');
    expect(cells.slice(6, 13)).toEqual([
      'USD',
      'VES',
      '3600.00',
      '',
      '',
      '',
      '',
    ]);
  });
});
