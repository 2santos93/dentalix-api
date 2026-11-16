import {
  mergeIntervals,
  placedVisit,
  placementOverflows,
  planVisitOffset,
  shiftIntervals,
} from './plan-template-placement';

describe('colocación de la plantilla en el plan (DX-559, D4)', () => {
  it('en un plan vacío las visitas 1, 2 y 3 quedan como 1, 2 y 3', () => {
    const offset = planVisitOffset([]);
    expect(offset).toBe(0);
    expect([1, 2, 3].map((v) => placedVisit(v, offset))).toEqual([1, 2, 3]);
    expect(shiftIntervals({ '2': 7, '3': 14 }, offset)).toEqual({
      '2': 7,
      '3': 14,
    });
  });

  it('con visitas vivas, van detrás de la mayor', () => {
    const offset = planVisitOffset([{ visit: 1 }, { visit: 4 }, { visit: 2 }]);
    expect(offset).toBe(4);
    expect([1, 2, 3].map((v) => placedVisit(v, offset))).toEqual([5, 6, 7]);
    expect(shiftIntervals({ '2': 7, '3': 14 }, offset)).toEqual({
      '6': 7,
      '7': 14,
    });
  });

  it('la fusión no pisa una clave que el plan ya tenga', () => {
    expect(mergeIntervals({ '2': 30, '5': 1 }, { '5': 7, '6': 14 })).toEqual({
      '2': 30,
      '5': 1,
      '6': 14,
    });
  });

  it('desborda si una visita o una clave pasaría de 1000', () => {
    expect(placementOverflows([1, 2], {}, 998)).toBe(false);
    expect(placementOverflows([1, 2, 3], {}, 998)).toBe(true);
    expect(placementOverflows([1], { '3': 2 }, 998)).toBe(true);
    expect(placementOverflows([1], { '2': 2 }, 998)).toBe(false);
  });
});
