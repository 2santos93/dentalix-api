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
  catalogCurrency: null,
  referenceCurrency: null,
  referencePriceInPlan: null,
  basePriceInPlan: null,
  rate: null,
  baseRate: null,
  agreementUnmeasured: false,
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
        // DX-513-ter: sin convenio, las dos columnas nuevas vacías.
        '',
        '',
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
    expect(cells.slice(22, 27)).toEqual([
      '"Cortesía socios"',
      '2000000',
      '2000000',
      '"Admin Clínica"',
      '"Dr. Pérez"',
    ]);
    expect(DISCOUNT_REPORT_CSV_HEADER.slice(22, 27)).toEqual([
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
      'Tasa (por 1 USD: catálogo / plan)',
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

  describe('L1: «Precio sin convenio» con su moneda real', () => {
    const agreed: DiscountReportRowView = {
      ...row,
      currency: 'USD',
      priceSource: 'AGREEMENT_PERCENT',
      agreementName: 'Seguros Caracas',
      catalogCurrency: 'VES',
      referenceCurrency: 'VES',
      catalogPrice: 3240,
      basePrice: 3600,
      price: 3.68,
      priceReduction: 0,
      itemDiscount: 0,
      discount: 0,
      percent: 0,
      reason: null,
      reasonNote: null,
    };
    const baseCell = (r: DiscountReportRowView) =>
      toDiscountReportCsv([r]).slice(1).split('\r\n')[1].split(',')[23];

    it('con foto entre monedas: la base convertida, en la moneda del plan', () => {
      expect(DISCOUNT_REPORT_CSV_HEADER[23]).toBe('Precio sin convenio');
      expect(
        baseCell({
          ...agreed,
          basePriceInPlan: 4.09,
          referencePriceInPlan: 3.68,
          agreementReduction: 0.41,
        }),
      ).toBe('4.09');
    });

    it('sin foto, la base del catálogo en VES va con «VES», nunca como USD', () => {
      expect(baseCell({ ...agreed, basePriceInPlan: null })).toBe(
        '3600.00 VES',
      );
    });

    it('misma moneda (o moneda desconocida): el importe tal cual', () => {
      expect(
        baseCell({ ...agreed, basePriceInPlan: null, catalogCurrency: 'USD' }),
      ).toBe('3600.00');
      expect(
        baseCell({ ...agreed, basePriceInPlan: null, catalogCurrency: null }),
      ).toBe('3600.00');
    });
  });

  // DX-513-ter: lista de convenio en USD (3,50) con el catálogo en VES
  // (3.600 Bs.). Medida: la base convertida (4,09) y la tasa congeladas;
  // sin medir: la rebaja por convenio VACÍA (nunca 0.00) y señalada.
  describe('DX-513-ter: listas de convenio entre monedas (test 13)', () => {
    const RATE = {
      fromPerBase: 880,
      toPerBase: 1,
      source: 'MANUAL' as const,
      rateDate: '2026-11-07',
    };
    const list: DiscountReportRowView = {
      ...row,
      currency: 'USD',
      priceSource: 'AGREEMENT_PRICE_LIST',
      agreementName: 'Empresa',
      catalogCurrency: 'VES',
      referenceCurrency: 'USD',
      catalogPrice: 3.5,
      referencePriceInPlan: 3.5,
      basePrice: 3600,
      price: 3.5,
      priceReduction: 0,
      itemDiscount: 0,
      discount: 0,
      percent: 0,
      reason: null,
      reasonNote: null,
      discountById: null,
      discountByName: null,
      agreementAssignedByName: 'Admin Clínica',
    };
    const cellsOf = (r: DiscountReportRowView) =>
      toDiscountReportCsv([r]).slice(1).split('\r\n')[1].split(',');

    it('las columnas de antes no se mueven; dos nuevas al final', () => {
      expect(DISCOUNT_REPORT_CSV_HEADER).toHaveLength(29);
      expect(DISCOUNT_REPORT_CSV_HEADER[10]).toBe(
        'Tasa (por 1 USD: catálogo / plan)',
      );
      expect(DISCOUNT_REPORT_CSV_HEADER[24]).toBe('Rebaja por convenio');
      expect(DISCOUNT_REPORT_CSV_HEADER.slice(27)).toEqual([
        'Precio sin convenio en la moneda del catálogo',
        'Rebaja por convenio medida',
      ]);
    });

    it('medida: la rebaja, la base convertida y la tasa de la base', () => {
      const cells = cellsOf({
        ...list,
        basePriceInPlan: 4.09,
        baseRate: RATE,
        agreementReduction: 0.59,
        agreementPercent: 14.43,
      });
      expect(cells.slice(10, 13)).toEqual(['880 / 1', 'Manual', '2026-11-07']);
      expect(cells[18]).toBe('"Convenio Empresa"');
      expect(cells.slice(23, 25)).toEqual(['4.09', '0.59']);
      expect(cells.slice(27)).toEqual(['3600.00 VES', 'Sí']);
    });

    it('sin medir: la rebaja por convenio vacía (no 0.00), señalada y sin tasa', () => {
      const cells = cellsOf({ ...list, agreementUnmeasured: true });
      expect(cells.slice(10, 13)).toEqual(['', '', '']);
      expect(cells[18]).toBe('"Convenio Empresa"');
      expect(cells[20]).toBe('"Admin Clínica"');
      expect(cells[24]).toBe('');
      expect(cells.slice(27)).toEqual([
        '3600.00 VES',
        'Sin referencia comparable',
      ]);
    });

    it('con descuento propio y sin medir: el descuento sale y la rebaja por convenio sigue vacía', () => {
      const cells = cellsOf({
        ...list,
        agreementUnmeasured: true,
        itemDiscount: 0.5,
        discount: 0.5,
        reason: DiscountReason.LOYALTY,
      });
      expect(cells[16]).toBe('0.50');
      expect(cells[24]).toBe('');
      expect(cells[28]).toBe('Sin referencia comparable');
    });

    // DX-513-quater: lista de convenio con la moneda del catálogo NULL.
    describe('moneda del catálogo desconocida', () => {
      const UNKNOWN = '3600.00 (moneda del catálogo desconocida)';
      const unknownList = {
        ...list,
        catalogCurrency: null,
        referenceCurrency: 'USD',
        basePriceInPlan: 3600,
        referencePriceInPlan: 3.5,
        agreementUnmeasured: true,
        agreementReduction: 0,
      };

      it('lista: rebaja vacía, «Sin referencia comparable» y la base marcada (N1, N2)', () => {
        const cells = cellsOf(unknownList);
        expect(cells[23]).toBe(UNKNOWN);
        expect(cells[24]).toBe('');
        expect(cells[27]).toBe(UNKNOWN);
        expect(cells[28]).toBe('Sin referencia comparable');
      });

      it('lista sin foto: la misma marca', () => {
        const cells = cellsOf({
          ...unknownList,
          basePriceInPlan: null,
          referencePriceInPlan: null,
        });
        expect(cells[23]).toBe(UNKNOWN);
        expect(cells[27]).toBe(UNKNOWN);
        expect(cells[28]).toBe('Sin referencia comparable');
      });

      it('convenio por %: se sigue midiendo; solo la columna de la moneda del catálogo lleva la marca', () => {
        const cells = cellsOf({
          ...list,
          priceSource: 'AGREEMENT_PERCENT',
          catalogCurrency: null,
          basePriceInPlan: 3600,
          catalogPrice: 3240,
          referencePriceInPlan: 3240,
          price: 3240,
          agreementUnmeasured: false,
          agreementReduction: 360,
        });
        expect(cells[23]).toBe('3600.00');
        expect(cells[24]).toBe('360.00');
        expect(cells[27]).toBe(UNKNOWN);
        expect(cells[28]).toBe('Sí');
      });
    });

    it('sin convenio: las dos columnas nuevas vacías', () => {
      expect(cellsOf(row).slice(27)).toEqual(['', '']);
    });
  });
});
