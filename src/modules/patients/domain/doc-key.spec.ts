import { docKey } from './doc-key';
import { DOC_KEY_CASES } from './__fixtures__/doc-key-cases';

describe('docKey (DX-107, DX-287)', () => {
  it.each(DOC_KEY_CASES)('«%s» → «%s»', (input, expected) => {
    expect(docKey(input)).toBe(expected);
  });

  it('el mismo documento escrito distinto da la misma clave', () => {
    const keys = new Set(
      ['1.111.111', '1111111', '1-111-111', ' 1 111 111 '].map(docKey),
    );
    expect([...keys]).toEqual(['1111111']);
  });

  it('solo deja A-Z y 0-9 (la clave cabe en el índice tal cual)', () => {
    const all = Array.from({ length: 0x3000 }, (_, i) =>
      String.fromCharCode(i),
    ).join('');
    expect(docKey(all)).toBe(
      '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ',
    );
  });
});
