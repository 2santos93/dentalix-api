import { validateVisits, minimumVisitDate, isUnscheduled } from './plan-visits';

describe('organización clínica por visitas DX-256', () => {
  it('acepta tres ítems en dos visitas con intervalo de 90 días', () => {
    expect(() =>
      validateVisits(
        'ACCEPTED',
        [
          { itemId: 'a', visit: 1 },
          { itemId: 'b', visit: 2 },
          { itemId: 'c', visit: 2 },
        ],
        { '2': 90 },
      ),
    ).not.toThrow();
  });
  it.each(['COMPLETED', 'CANCELLED', 'REJECTED'])(
    'rechaza organizar un plan %s',
    (status) => {
      expect(() =>
        validateVisits(status, [{ itemId: 'a', visit: 1 }], {}),
      ).toThrow('cerrado');
    },
  );
  it.each([0, -1, 1.5, 1001])('rechaza visita %s', (visit) => {
    expect(() => validateVisits('DRAFT', [{ itemId: 'a', visit }], {})).toThrow(
      'visita',
    );
  });
  it('rechaza duplicados, etiquetas largas e intervalos inválidos', () => {
    expect(() =>
      validateVisits(
        'DRAFT',
        [
          { itemId: 'a', visit: 1 },
          { itemId: 'a', visit: 2 },
        ],
        {},
      ),
    ).toThrow('repetido');
    expect(() =>
      validateVisits(
        'DRAFT',
        [{ itemId: 'a', visit: 1, visitLabel: 'a'.repeat(61) }],
        {},
      ),
    ).toThrow('60');
    expect(() =>
      validateVisits('DRAFT', [{ itemId: 'a', visit: 1 }], { '2': -1 }),
    ).toThrow('intervalo');
  });
  it('calcula la fecha mínima desde la última cita realizada de la visita anterior', () => {
    expect(
      minimumVisitDate(
        new Date('2026-01-01T00:00:00Z'),
        90,
        new Date('2026-01-10T15:00:00Z'),
      ).toISOString(),
    ).toBe('2026-04-01T00:00:00.000Z');
  });
  it('respeta el día civil de Bogotá y el cambio DST de Madrid', () => {
    expect(
      minimumVisitDate(
        new Date('2026-01-02T00:30:00Z'),
        90,
        new Date('2026-01-01T00:00:00Z'),
        'America/Bogota',
      ).toISOString(),
    ).toBe('2026-04-01T05:00:00.000Z');
    expect(
      minimumVisitDate(
        new Date('2026-03-28T10:00:00Z'),
        2,
        new Date('2026-03-01T00:00:00Z'),
        'Europe/Madrid',
      ).toISOString(),
    ).toBe('2026-03-29T22:00:00.000Z');
  });
  it('sin antecedente o intervalo sugiere hoy y nunca una fecha pasada', () => {
    const now = new Date('2026-10-21T12:00:00Z');
    expect(minimumVisitDate(null, 90, now)).toEqual(now);
    expect(minimumVisitDate(new Date('2020-01-01'), 0, now)).toEqual(now);
    expect(minimumVisitDate(new Date('2020-01-01'), 90, now)).toEqual(now);
  });
  it('selecciona solo ítems aceptados de plan aceptado sin cita futura viva', () => {
    const now = new Date('2026-10-21T12:00:00Z');
    expect(isUnscheduled('ACCEPTED', 'ACCEPTED', [], now)).toBe(true);
    expect(isUnscheduled('PRESENTED', 'ACCEPTED', [], now)).toBe(false);
    expect(isUnscheduled('ACCEPTED', 'DONE', [], now)).toBe(false);
    expect(
      isUnscheduled(
        'ACCEPTED',
        'ACCEPTED',
        [{ start: new Date('2026-10-22'), status: 'SCHEDULED' }],
        now,
      ),
    ).toBe(false);
    expect(
      isUnscheduled(
        'ACCEPTED',
        'ACCEPTED',
        [{ start: new Date('2026-10-22'), status: 'CANCELLED' }],
        now,
      ),
    ).toBe(true);
    expect(
      isUnscheduled(
        'ACCEPTED',
        'ACCEPTED',
        [{ start: new Date('2026-10-20'), status: 'SCHEDULED' }],
        now,
      ),
    ).toBe(true);
  });
});
