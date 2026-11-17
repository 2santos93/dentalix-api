import { uuidV7 } from './uuid-v7';

describe('uuidV7', () => {
  it('versión 7, variante RFC y ordenado por milisegundo', () => {
    const a = uuidV7(Date.UTC(2026, 10, 16));
    const b = uuidV7(Date.UTC(2026, 10, 16) + 1);
    for (const id of [a, b]) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    expect(a < b).toBe(true);
    expect(parseInt(a.replace(/-/g, '').slice(0, 12), 16)).toBe(
      Date.UTC(2026, 10, 16),
    );
  });
});
