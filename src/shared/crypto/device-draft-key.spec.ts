import { deriveDeviceDraftKey } from './device-draft-key';

const SECRET = 'x'.repeat(16) + 'secreto-de-prueba-largo-y-variado-123';
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const U2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('deriveDeviceDraftKey (DX-574)', () => {
  it('32 bytes, la misma para el mismo usuario y clínica (sobrevive a volver a entrar)', () => {
    const a = deriveDeviceDraftKey(SECRET, T1, U1);
    expect(a).toHaveLength(32);
    expect(deriveDeviceDraftKey(SECRET, T1.toUpperCase(), U1)).toEqual(a);
  });

  it('otra para otro usuario, otra clínica u otro secreto', () => {
    const a = deriveDeviceDraftKey(SECRET, T1, U1);
    expect(deriveDeviceDraftKey(SECRET, T1, U2)).not.toEqual(a);
    expect(deriveDeviceDraftKey(SECRET, T2, U1)).not.toEqual(a);
    expect(deriveDeviceDraftKey(`${SECRET}!`, T1, U1)).not.toEqual(a);
  });

  it('sin secreto no deriva nada', () => {
    expect(() => deriveDeviceDraftKey('', T1, U1)).toThrow();
  });
});
