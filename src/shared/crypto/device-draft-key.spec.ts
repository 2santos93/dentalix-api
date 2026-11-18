import { deriveDeviceDraftKey } from './device-draft-key';

const SECRET = 'solo-test-drafts-7c1e4a9b2d5f8e3a6c0b9d2e5f8a1c4b';
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const U2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('deriveDeviceDraftKey (DX-574)', () => {
  it('32 bytes, la misma para el mismo usuario, clínica y versión (sobrevive a volver a entrar)', () => {
    const a = deriveDeviceDraftKey(SECRET, T1, U1, 0);
    expect(a).toHaveLength(32);
    expect(deriveDeviceDraftKey(SECRET, T1.toUpperCase(), U1, 0)).toEqual(a);
  });

  it('otra para otro usuario, otra clínica, otra tokenVersion u otro secreto', () => {
    const a = deriveDeviceDraftKey(SECRET, T1, U1, 3);
    expect(deriveDeviceDraftKey(SECRET, T1, U2, 3)).not.toEqual(a);
    expect(deriveDeviceDraftKey(SECRET, T2, U1, 3)).not.toEqual(a);
    expect(deriveDeviceDraftKey(SECRET, T1, U1, 4)).not.toEqual(a);
    expect(deriveDeviceDraftKey(`${SECRET}x`, T1, U1, 3)).not.toEqual(a);
  });

  it('sin secreto o con una versión inválida no deriva nada', () => {
    expect(() => deriveDeviceDraftKey('', T1, U1, 0)).toThrow();
    expect(() => deriveDeviceDraftKey(SECRET, T1, U1, -1)).toThrow();
    expect(() => deriveDeviceDraftKey(SECRET, T1, U1, 1.5)).toThrow();
  });
});
