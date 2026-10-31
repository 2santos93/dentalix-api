import { REFERENCE_CURRENCY_DIGITS } from '../../../shared/money/__fixtures__/reference-currency-digits';
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

describe('CSV del informe de descuentos (DX-204)', () => {
  it('UTF-8 con BOM, CRLF, cabecera y una línea por ítem', () => {
    const csv = toDiscountReportCsv([row], REFERENCE_CURRENCY_DIGITS);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(DISCOUNT_REPORT_CSV_HEADER.join(','));
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
  });

  it('protege contra la inyección de fórmulas y escapa comillas', () => {
    const line = toDiscountReportCsv([row], REFERENCE_CURRENCY_DIGITS)
      .slice(1)
      .split('\r\n')[1];
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

  it('importes en la unidad de la moneda: COP sin decimales, EUR a céntimos', () => {
    const cop: DiscountReportRowView = {
      ...row,
      currency: 'COP',
      price: 123457,
      itemDiscount: 9259,
      discount: 9259,
      percent: 7.5,
    };
    const [, eurLine, copLine] = toDiscountReportCsv(
      [row, cop],
      REFERENCE_CURRENCY_DIGITS,
    )
      .slice(1)
      .split('\r\n');
    expect(eurLine.split(',').slice(7, 13)).toEqual([
      '',
      '450.00',
      '0.00',
      '67.50',
      '67.50',
      '15.00',
    ]);
    expect(copLine.split(',').slice(7, 13)).toEqual([
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
      currency: 'COP',
      catalogPrice: 1000000,
      price: 500000,
      priceReduction: 500000,
      itemDiscount: 0,
      discount: 500000,
      percent: 50,
    };
    const line = toDiscountReportCsv([reduced], REFERENCE_CURRENCY_DIGITS)
      .slice(1)
      .split('\r\n')[1];
    expect(line.split(',').slice(7, 13)).toEqual([
      '1000000',
      '500000',
      '500000',
      '0',
      '500000',
      '50.00',
    ]);
    expect(DISCOUNT_REPORT_CSV_HEADER.slice(7, 13)).toEqual([
      'Precio de catálogo',
      'Precio',
      'Rebaja de precio',
      'Descuento del ítem',
      'Descuento total',
      'Descuento (%)',
    ]);
  });

  it('el diente también va entre comillas y protegido (dato heredado sin validar)', () => {
    const line = toDiscountReportCsv(
      [{ ...row, toothNumber: '=1+1' }],
      REFERENCE_CURRENCY_DIGITS,
    )
      .slice(1)
      .split('\r\n')[1];
    expect(line).toContain(`,"'=1+1",`);
  });

  it('SEC-047: la rebaja de convenio sale aparte, con quién asignó el convenio y quién creó el ítem', () => {
    const agreed: DiscountReportRowView = {
      ...row,
      currency: 'COP',
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
    const cells = toDiscountReportCsv([agreed], REFERENCE_CURRENCY_DIGITS)
      .slice(1)
      .split('\r\n')[1]
      .split(',');
    // B5: una línea solo de convenio dice «Convenio …» como motivo y lleva el
    // autor real (quien asignó el convenio), no un descuento sin autor.
    expect(cells[13]).toBe('"Convenio Cortesía socios"');
    expect(cells[15]).toBe('"Admin Clínica"');
    expect(cells.slice(17)).toEqual([
      '"Cortesía socios"',
      '2000000',
      '2000000',
      '"Admin Clínica"',
      '"Dr. Pérez"',
    ]);
    expect(DISCOUNT_REPORT_CSV_HEADER.slice(17)).toEqual([
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
      agreementName: 'Sura',
      basePrice: 100,
      agreementReduction: 10,
      agreementAssignedByName: null,
      createdByName: 'Dr. Pérez',
      discountByName: null,
    };
    const cells = toDiscountReportCsv([agreed], REFERENCE_CURRENCY_DIGITS)
      .slice(1)
      .split('\r\n')[1]
      .split(',');
    expect(cells[15]).toBe('"Dr. Pérez"');
  });
});
