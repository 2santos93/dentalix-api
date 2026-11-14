import {
  EXTERNAL_INVOICE_NUMBER_MAX,
  RECEIPT_LEGEND_MAX,
  RECEIPT_TITLE_MAX,
  effectiveReceiptLegend,
  normalizeReceiptText,
} from './receipt-settings';

describe('normalizeReceiptText (DX-515)', () => {
  it('recorta y deja null lo vacío o ausente', () => {
    expect(normalizeReceiptText('  Recibo de pago  ', RECEIPT_TITLE_MAX)).toBe(
      'Recibo de pago',
    );
    expect(normalizeReceiptText('   ', RECEIPT_TITLE_MAX)).toBeNull();
    expect(normalizeReceiptText('', RECEIPT_TITLE_MAX)).toBeNull();
    expect(normalizeReceiptText(null, RECEIPT_TITLE_MAX)).toBeNull();
    expect(normalizeReceiptText(undefined, RECEIPT_TITLE_MAX)).toBeNull();
  });

  it('no exige formato: letras, números, guiones, barras y emoji valen', () => {
    for (const value of ['00-001234', 'A/2026/77', 'F 12', 'Nº 7 ✅', 'x']) {
      expect(normalizeReceiptText(value, EXTERNAL_INVOICE_NUMBER_MAX)).toBe(
        value,
      );
    }
  });

  it('rechaza (undefined) lo que pasa del tope, contado en caracteres', () => {
    expect(
      normalizeReceiptText('a'.repeat(RECEIPT_LEGEND_MAX), RECEIPT_LEGEND_MAX),
    ).toHaveLength(RECEIPT_LEGEND_MAX);
    expect(
      normalizeReceiptText(
        'a'.repeat(RECEIPT_LEGEND_MAX + 1),
        RECEIPT_LEGEND_MAX,
      ),
    ).toBeUndefined();
    // Un emoji es un carácter (como char_length en la BD), no dos.
    expect(
      normalizeReceiptText('✅'.repeat(RECEIPT_TITLE_MAX), RECEIPT_TITLE_MAX),
    ).toBe('✅'.repeat(RECEIPT_TITLE_MAX));
  });

  it('rechaza saltos de línea y caracteres de control', () => {
    for (const value of ['a\nb', 'a\tb', 'a\u2028b', 'a\u0000b']) {
      expect(normalizeReceiptText(value, RECEIPT_LEGEND_MAX)).toBeUndefined();
    }
  });
});

describe('effectiveReceiptLegend (DX-515)', () => {
  const clinic = { title: null, legend: 'Leyenda de la clínica' };

  it('una sede sin leyenda propia usa la de la clínica', () => {
    expect(
      effectiveReceiptLegend(clinic, { override: false, legend: null }),
    ).toBe('Leyenda de la clínica');
  });

  it('una sede con leyenda propia usa la suya', () => {
    expect(
      effectiveReceiptLegend(clinic, { override: true, legend: 'De la sede' }),
    ).toBe('De la sede');
  });

  it('una sede con leyenda propia vacía no imprime ninguna', () => {
    expect(
      effectiveReceiptLegend(clinic, { override: true, legend: null }),
    ).toBeNull();
  });

  it('sin leyenda en la clínica ni en la sede, ninguna', () => {
    expect(
      effectiveReceiptLegend(
        { title: null, legend: null },
        { override: false, legend: null },
      ),
    ).toBeNull();
  });
});
