import { parseCron } from './cron';

const at = (iso: string): Date => new Date(iso);

describe('parseCron (UTC, 5 campos)', () => {
  it('cada minuto: el siguiente minuto entero, nunca el mismo instante', () => {
    const cron = parseCron('* * * * *');
    expect(cron.next(at('2026-10-16T10:00:00.000Z'))).toEqual(
      at('2026-10-16T10:01:00.000Z'),
    );
    expect(cron.next(at('2026-10-16T10:00:59.999Z'))).toEqual(
      at('2026-10-16T10:01:00.000Z'),
    );
  });

  it('a una hora fija del día: hoy si aún no ha pasado, si no mañana', () => {
    const cron = parseCron('5 3 * * *');
    expect(cron.next(at('2026-10-16T01:00:00Z'))).toEqual(
      at('2026-10-16T03:05:00Z'),
    );
    expect(cron.next(at('2026-10-16T03:05:00Z'))).toEqual(
      at('2026-10-17T03:05:00Z'),
    );
  });

  it('pasos, rangos y listas', () => {
    expect(parseCron('*/15 * * * *').next(at('2026-10-16T10:07:00Z'))).toEqual(
      at('2026-10-16T10:15:00Z'),
    );
    expect(
      parseCron('0 8-10/2 * * *').next(at('2026-10-16T08:30:00Z')),
    ).toEqual(at('2026-10-16T10:00:00Z'));
    expect(parseCron('0 9,17 * * *').next(at('2026-10-16T09:30:00Z'))).toEqual(
      at('2026-10-16T17:00:00Z'),
    );
  });

  it('cambia de mes y de año', () => {
    expect(parseCron('0 0 1 * *').next(at('2026-12-15T00:00:00Z'))).toEqual(
      at('2027-01-01T00:00:00Z'),
    );
    expect(parseCron('0 0 29 2 *').next(at('2026-03-01T00:00:00Z'))).toEqual(
      at('2028-02-29T00:00:00Z'),
    );
  });

  it('día de la semana (0 y 7 son domingo) y la regla OR de cron cuando día del mes y de la semana están acotados', () => {
    // 2026-10-16 es viernes.
    expect(parseCron('0 6 * * 1').next(at('2026-10-16T00:00:00Z'))).toEqual(
      at('2026-10-19T06:00:00Z'),
    );
    expect(parseCron('0 6 * * 7').next(at('2026-10-16T00:00:00Z'))).toEqual(
      at('2026-10-18T06:00:00Z'),
    );
    // Día 20 O lunes: el lunes 19 llega antes.
    expect(parseCron('0 6 20 * 1').next(at('2026-10-16T00:00:00Z'))).toEqual(
      at('2026-10-19T06:00:00Z'),
    );
  });

  it.each([
    [''],
    ['* * * *'],
    ['* * * * * *'],
    ['60 * * * *'],
    ['* 24 * * *'],
    ['* * 0 * *'],
    ['* * * 13 *'],
    ['* * * * 8'],
    ['*/0 * * * *'],
    ['5-1 * * * *'],
    ['a * * * *'],
    ['1,,2 * * * *'],
  ])('rechaza la expresión inválida %p', (expr) => {
    expect(() => parseCron(expr)).toThrow(/cron/i);
  });

  it('rechaza una fecha imposible (30 de febrero) en vez de buscar para siempre', () => {
    expect(() => parseCron('0 0 30 2 *')).toThrow(/nunca/);
  });
});
