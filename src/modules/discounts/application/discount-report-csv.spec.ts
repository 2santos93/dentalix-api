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
  price: 450,
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
};

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
        '36',
        '"Corona ""zirconio"""',
        'EUR',
        '450.00',
        '67.50',
        '15.00',
        '"Otro"',
        `"'+cmd malicioso"`,
        `"'@admin"`,
        `"' -Sede"`,
      ].join(','),
    );
  });
});
