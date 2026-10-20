import { activeLocationIds } from './membership-locations';

function row(id: string, isActive = true, deletedAt: Date | null = null) {
  return { location: { id, isActive, deletedAt } };
}

describe('activeLocationIds (DX-089)', () => {
  it('sin filas → null (todas las sedes)', () => {
    expect(activeLocationIds([])).toBeNull();
  });

  it('con filas → solo las sedes activas y no borradas, en orden', () => {
    expect(
      activeLocationIds([
        row('a'),
        row('inactiva', false),
        row('borrada', true, new Date()),
        row('b'),
      ]),
    ).toEqual(['a', 'b']);
  });

  it('con filas pero ninguna activa → [] (nunca todas)', () => {
    expect(activeLocationIds([row('x', false)])).toEqual([]);
  });
});
