import { payerConflict } from './single-payer';

const ana = { id: 'a', isPayer: true, name: 'Ana Pérez' };
const luis = { id: 'l', isPayer: false, name: 'Luis Pérez' };

describe('payerConflict (DX-203: un solo pagador principal)', () => {
  it('sin pagador previo, el alta como pagador se acepta', () => {
    expect(payerConflict([luis], { isPayer: true })).toBeNull();
  });

  it('un segundo pagador choca con el que ya hay', () => {
    expect(payerConflict([ana, luis], { isPayer: true })).toBe(ana);
    expect(payerConflict([ana, luis], { id: 'l', isPayer: true })).toBe(ana);
  });

  it('el propio pagador puede seguir siéndolo, y quien no paga no choca', () => {
    expect(payerConflict([ana, luis], { id: 'a', isPayer: true })).toBeNull();
    expect(payerConflict([ana, luis], { isPayer: false })).toBeNull();
  });
});
