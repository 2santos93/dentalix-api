import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FAKE_NOW_ENV,
  calendarBoundary,
  parseFakeNow,
  shiftedDate,
} from '../support/calendar-clock';

// DX-495 (TST-062): el job «fronteras de calendario» corre unit, int y e2e con
// el reloj del proceso fijado (FAKE_NOW) a fin de mes, a la medianoche de la
// sede y a fin de año. El reloj avanza desde esa hora (no se congela: las
// esperas por plazo siguen terminando) y solo cambia lo que lee `Date`.

const REPO_ROOT = join(__dirname, '..', '..');

describe('DX-495: reloj de las fronteras de calendario', () => {
  const RealDate = Date;

  it('sin argumentos arranca en la hora fijada y avanza con el reloj real', () => {
    const real = RealDate.now();
    const target = Date.parse('2026-10-31T23:59:30Z');
    const Shifted = shiftedDate(RealDate, target - real);
    expect(Math.abs(Shifted.now() - target)).toBeLessThan(1000);
    expect(Math.abs(new Shifted().getTime() - target)).toBeLessThan(1000);
    expect(Shifted.now()).toBeGreaterThanOrEqual(target);
  });

  it('con argumentos se comporta como Date y mantiene los estáticos', () => {
    const Shifted = shiftedDate(RealDate, 86_400_000);
    expect(new Shifted('2026-01-01T00:00:00Z').toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(new Shifted(0).getTime()).toBe(0);
    expect(new Shifted(Date.UTC(2026, 11, 31)).toISOString()).toBe(
      '2026-12-31T00:00:00.000Z',
    );
    expect(Shifted.UTC(2026, 0, 1)).toBe(RealDate.UTC(2026, 0, 1));
    expect(Shifted.parse('2026-01-01T00:00:00Z')).toBe(
      RealDate.parse('2026-01-01T00:00:00Z'),
    );
  });

  it('las fechas de uno y otro Date se reconocen como Date', () => {
    const Shifted = shiftedDate(RealDate, 1000);
    expect(new Shifted()).toBeInstanceOf(RealDate);
    expect(new RealDate()).toBeInstanceOf(Shifted);
    expect(Object.prototype.toString.call(new Shifted())).toBe('[object Date]');
  });

  it('comparte el prototype: un spy sobre Date.prototype alcanza a las dos', () => {
    const Shifted = shiftedDate(RealDate, 1000);
    expect(Shifted.prototype).toBe(RealDate.prototype);
    const spy = jest
      .spyOn(Shifted.prototype, 'getFullYear')
      .mockReturnValue(1999);
    try {
      expect(new Shifted().getFullYear()).toBe(1999);
      expect(new RealDate().getFullYear()).toBe(1999);
    } finally {
      spy.mockRestore();
    }
  });

  it('Date() sin new devuelve el texto de la hora fijada', () => {
    const Shifted = shiftedDate(
      RealDate,
      Date.UTC(2030, 0, 1) - RealDate.now(),
    );
    expect((Shifted as unknown as () => string)()).toContain('2030');
  });

  it('FAKE_NOW acepta un instante ISO con zona y rechaza lo demás', () => {
    expect(parseFakeNow('2026-12-31T23:59:30Z')).toBe(
      Date.parse('2026-12-31T23:59:30Z'),
    );
    expect(parseFakeNow(undefined)).toBeNull();
    expect(parseFakeNow('')).toBeNull();
    expect(() => parseFakeNow('2026-12-31T23:59:30')).toThrow(FAKE_NOW_ENV);
    expect(() => parseFakeNow('mañana')).toThrow(FAKE_NOW_ENV);
  });

  it('FAKE_NOW acepta el nombre de una frontera y la resuelve desde hoy', () => {
    const today = new Date('2026-11-01T03:45:00Z');
    expect(parseFakeNow('fin-de-mes', today)).toBe(
      Date.parse('2026-10-31T23:59:30Z'),
    );
    expect(parseFakeNow('medianoche-sede', today)).toBe(
      Date.parse('2026-11-01T05:01:00Z'),
    );
    expect(parseFakeNow('fin-de-anio', today)).toBe(
      Date.parse('2026-12-31T23:59:30Z'),
    );
  });

  describe('calendarBoundary', () => {
    const today = new Date('2026-11-01T03:45:00Z');

    it('fin de mes: el último día 31 ya empezado, sin diciembre', () => {
      expect(calendarBoundary('fin-de-mes', today)).toBe(
        '2026-10-31T23:59:30Z',
      );
      expect(
        calendarBoundary('fin-de-mes', new Date('2027-01-15T00:00:00Z')),
      ).toBe('2026-10-31T23:59:30Z');
      expect(
        calendarBoundary('fin-de-mes', new Date('2027-02-01T00:00:00Z')),
      ).toBe('2027-01-31T23:59:30Z');
    });

    it('medianoche de la sede: el día 1 del mes en curso a las 05:01 UTC', () => {
      expect(calendarBoundary('medianoche-sede', today)).toBe(
        '2026-11-01T05:01:00Z',
      );
    });

    it('fin de año: el 31 de diciembre más cercano', () => {
      expect(calendarBoundary('fin-de-anio', today)).toBe(
        '2026-12-31T23:59:30Z',
      );
      expect(
        calendarBoundary('fin-de-anio', new Date('2027-03-01T00:00:00Z')),
      ).toBe('2026-12-31T23:59:30Z');
      expect(
        calendarBoundary('fin-de-anio', new Date('2027-08-01T00:00:00Z')),
      ).toBe('2027-12-31T23:59:30Z');
    });
  });

  it('las cuatro configuraciones de jest cargan el reloj (unit, int, e2e, owner-nosu)', () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { jest: { setupFiles?: string[] } };
    const configs: Array<[string, string[] | undefined]> = [
      ['package.json', pkg.jest.setupFiles],
      ...['jest-int.json', 'jest-e2e.json', 'jest-owner-nosu.json'].map(
        (file): [string, string[] | undefined] => [
          file,
          (
            JSON.parse(readFileSync(join(REPO_ROOT, 'test', file), 'utf8')) as {
              setupFiles?: string[];
            }
          ).setupFiles,
        ],
      ),
    ];
    for (const [file, setupFiles] of configs) {
      expect([
        file,
        (setupFiles ?? []).some((f) => f.endsWith('setup-calendar-clock.ts')),
      ]).toEqual([file, true]);
    }
  });
});
