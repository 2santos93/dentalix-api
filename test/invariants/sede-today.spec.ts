import { join } from 'node:path';
import { civilDateIn } from '../../src/shared/time/civil-day';
import {
  NOON_ZONE_CANDIDATES,
  SEDE_FIXTURE_ZONE,
  SEDE_TODAY_MARGIN_MINUTES,
  civilDaysSince,
  minutesIntoDay,
  safeTodayZone,
  sedeTodayFixture,
} from '../support/sede-clock';
import { readSpecs } from './bare-delete-many';
import { findRealClockToday } from './real-clock-today';

// DX-449 (TST-053): los specs de agenda y reservas calculaban «hoy» con el
// reloj real y una zona fija (UTC−4); entre las 03:40 y las 05:00 UTC (la
// medianoche de la sede, cuando el loop fusiona) sus citas «de hoy que ya
// empezaron» caían en ayer o se solapaban. Un spec nuevo que hable de «hoy»
// (un identificador con today/TODAY) y lea el reloj real (`Date.now()` o
// `new Date()`) tiene que pasar por `test/support/sede-clock.ts`
// (`sedeTodayFixture`, `fixedSedeDay`, `civilDaysSince`) o por el reloj
// inyectado del módulo.

const REPO_ROOT = join(__dirname, '..', '..');

/**
 * Lista blanca: specs anteriores a DX-449 que nombran «hoy» y leen el reloj
 * real sin sede-clock. DX-460 revisó uno por uno los 27 que quedaban: en 8 el
 * «hoy» se fijaba en beforeAll, al cargar el módulo o en un test anterior y se
 * comparaba tests después con el que calcula la API con su reloj real (fallo
 * real al cruzar la medianoche de la sede); esos 8 ya usan sede-clock y
 * salieron de aquí. En los 19 que siguen, «hoy» es un campo de la respuesta
 * (offersToday, registeredToday), un literal, un día UTC, un reloj ya
 * inyectado o un cálculo y su comprobación dentro del mismo test (carrera de
 * milisegundos, la misma que aceptan los specs migrados). El patrón es léxico
 * y los sigue marcando: se quedan aquí, documentados, y no se tocan por
 * maquillaje. Solo puede bajar: cada entrada tiene que seguir cumpliendo el
 * patrón (un spec migrado sale de aquí) y un spec nuevo no entra.
 */
const LEGACY_REAL_CLOCK_TODAY: ReadonlySet<string> = new Set([
  'test/cash-sessions-concurrency.e2e-spec.ts',
  'test/clinical-codes.e2e-spec.ts',
  'test/collections-reopen.e2e-spec.ts',
  'test/exchange-provider-budget.e2e-spec.ts',
  'test/exchange-provider-quota.e2e-spec.ts',
  'test/exchange-rate-dates.e2e-spec.ts',
  'test/expense-cash-outflows.e2e-spec.ts',
  'test/implants.e2e-spec.ts',
  'test/jobs-maintenance.e2e-spec.ts',
  'test/opening-candidates.e2e-spec.ts',
  'test/patient-credit.e2e-spec.ts',
  'test/patient-flow.e2e-spec.ts',
  'test/payment-can-void.e2e-spec.ts',
  'test/payment-method-statement.e2e-spec.ts',
  'test/receivables.e2e-spec.ts',
  'test/collections.int-spec.ts',
  'test/opening-balances.int-spec.ts',
  'test/payment-promise-reopen.int-spec.ts',
  'test/waitlist-offers.int-spec.ts',
]);

describe('DX-449: «hoy» de la sede en los specs de agenda y reservas', () => {
  describe('safeTodayZone', () => {
    it('es Caracas cuando su medianoche queda lejos', () => {
      // 12:00 en la zona de la sede.
      expect(safeTodayZone(new Date('2026-10-31T16:00:00Z'))).toBe(
        SEDE_FIXTURE_ZONE,
      );
    });

    it.each([
      '2026-10-31T03:40:00Z',
      '2026-10-31T04:01:00Z',
      '2026-10-31T04:30:00Z',
      '2026-10-31T04:56:00Z',
      '2026-10-31T06:30:00Z',
    ])(
      'cerca de la medianoche de Caracas (%s) elige una zona lejos de la suya',
      (iso) => {
        const now = new Date(iso);
        const zone = safeTodayZone(now);
        expect(zone).not.toBe(SEDE_FIXTURE_ZONE);
        const minutes = minutesIntoDay(now, zone);
        expect(Math.abs(minutes - 12 * 60)).toBeLessThanOrEqual(30);
      },
    );

    it('a cualquier minuto del día deja el margen desde y hasta la medianoche', () => {
      const start = Date.parse('2026-10-31T00:00:00Z');
      for (let m = 0; m < 24 * 60; m += 7) {
        const now = new Date(start + m * 60_000);
        const minutes = minutesIntoDay(now, safeTodayZone(now));
        expect(minutes).toBeGreaterThanOrEqual(SEDE_TODAY_MARGIN_MINUTES);
        expect(24 * 60 - minutes).toBeGreaterThanOrEqual(
          SEDE_TODAY_MARGIN_MINUTES,
        );
      }
    });

    it('las candidatas son zonas válidas, sin horario de verano y una por hora', () => {
      const offsets = NOON_ZONE_CANDIDATES.map((zone) => {
        const jan = minutesIntoDay(new Date('2026-01-15T00:00:00Z'), zone);
        const jul = minutesIntoDay(new Date('2026-07-15T00:00:00Z'), zone);
        expect(jul).toBe(jan);
        return jan;
      });
      expect(new Set(offsets).size).toBe(NOON_ZONE_CANDIDATES.length);
    });

    it('«hace 3 h» y «ahora» son el mismo día de la sede en la franja de los merges', () => {
      for (const iso of ['2026-10-31T04:01:00Z', '2026-10-31T04:56:00Z']) {
        const now = new Date(iso);
        const { timeZone } = sedeTodayFixture(now);
        const before = new Date(now.getTime() - 179 * 60_000);
        expect(civilDateIn(before, timeZone)).toBe(civilDateIn(now, timeZone));
      }
    });
  });

  it('civilDaysSince da uno o dos días civiles, del más antiguo al último', () => {
    expect(
      civilDaysSince(60, SEDE_FIXTURE_ZONE, new Date('2026-10-31T16:00:00Z')),
    ).toEqual(['2026-10-31']);
    expect(
      civilDaysSince(60, SEDE_FIXTURE_ZONE, new Date('2026-10-31T04:20:00Z')),
    ).toEqual(['2026-10-30', '2026-10-31']);
  });

  it('detecta un spec nuevo con «hoy» del reloj real sin sede-clock', () => {
    const found = findRealClockToday([
      {
        path: 'test/nuevo.e2e-spec.ts',
        source: 'const startedToday = () => book(new Date(Date.now() - MIN));',
      },
      {
        path: 'test/nuevo.int-spec.ts',
        source: "const TODAY = civilDateIn(new Date(), 'America/Caracas');",
      },
      {
        path: 'test/migrado.e2e-spec.ts',
        source: [
          "import { sedeTodayFixture } from './support/sede-clock';",
          'const todayAppointment = () => book(new Date(Date.now() - MIN));',
        ].join('\n'),
      },
      {
        path: 'test/prosa.e2e-spec.ts',
        source: '// la cita de today\nconst start = new Date();',
      },
      {
        path: 'test/support/helper.ts',
        source: 'const today = new Date();',
      },
    ]);
    expect(found).toEqual(['test/nuevo.e2e-spec.ts', 'test/nuevo.int-spec.ts']);
  });

  it('DX-495: detecta el «hoy» en español de un título o un identificador', () => {
    const found = findRealClockToday([
      {
        // El caso de chairs.e2e-spec.ts:572 antes de DX-495: el «hoy» solo
        // está en el título y la cita «de hace 5 min» se lleva a ARRIVED.
        path: 'test/sillones.e2e-spec.ts',
        source: [
          "it('se cambia el sillón de una cita de hoy con el paciente ya en la clínica', async () => {",
          '  const start = new Date(Date.now() - 5 * 60_000);',
          "  await patch(id).send({ status: 'ARRIVED' }).expect(200);",
          '});',
        ].join('\n'),
      },
      {
        path: 'test/titulo.int-spec.ts',
        source: [
          "describe('Hoy en la agenda', () => {",
          "  it('cuenta la cita', () => book(new Date()));",
          '});',
        ].join('\n'),
      },
      {
        path: 'test/identificador.e2e-spec.ts',
        source: 'const citaDeHoy = () => book(new Date());',
      },
      {
        path: 'test/mensaje.e2e-spec.ts',
        source: [
          "it('rechaza el abono', () => {",
          '  const at = new Date();',
          "  expect(message).toBe('Solo puedes anular abonos registrados hoy.');",
          '});',
        ].join('\n'),
      },
      {
        path: 'test/prosa.int-spec.ts',
        source: '// la cita de hoy\nconst start = new Date();',
      },
      {
        path: 'test/etiqueta.int-spec.ts',
        source: [
          "it('«Sin cambios hoy» guarda autor y hora', () => {",
          '  const before = Date.now();',
          '});',
        ].join('\n'),
      },
    ]);
    expect(found).toEqual([
      'test/identificador.e2e-spec.ts',
      'test/sillones.e2e-spec.ts',
      'test/titulo.int-spec.ts',
    ]);
  });

  it('DX-495: detecta una cita de `Date.now() - n` que pasa a ARRIVED o IN_CHAIR', () => {
    const found = findRealClockToday([
      {
        path: 'test/llegada.e2e-spec.ts',
        source: [
          "it('el paciente llega', async () => {",
          '  const late = await appointment(new Date(Date.now() - 20 * MIN));',
          "  await setStatus(late, 'ARRIVED');",
          '});',
        ].join('\n'),
      },
      {
        path: 'test/sillon.int-spec.ts',
        source:
          "const start = Date.now() - HOUR; await move(start, 'IN_CHAIR');",
      },
      {
        path: 'test/futura.e2e-spec.ts',
        source:
          "const start = new Date(Date.now() + 7 * DAY); await setStatus(a, 'ARRIVED');",
      },
      {
        path: 'test/otro-test.e2e-spec.ts',
        source: [
          "it('una cita vieja', () => book(new Date(Date.now() - 400 * DAY)));",
          "it('llega', () => setStatus(future, 'ARRIVED'));",
        ].join('\n'),
      },
      {
        path: 'test/migrada.e2e-spec.ts',
        source: [
          "import { sedeTodayFixture } from './support/sede-clock';",
          "const start = new Date(Date.now() - 5 * MIN); setStatus(a, 'ARRIVED');",
        ].join('\n'),
      },
    ]);
    expect(found).toEqual([
      'test/llegada.e2e-spec.ts',
      'test/sillon.int-spec.ts',
    ]);
  });

  it('ningún spec fuera de la lista heredada calcula «hoy» con el reloj real', () => {
    const found = findRealClockToday(readSpecs(REPO_ROOT));
    expect(found.filter((path) => !LEGACY_REAL_CLOCK_TODAY.has(path))).toEqual(
      [],
    );
  });

  it('la lista heredada no tiene entradas viejas (un spec migrado sale de ella)', () => {
    const found = new Set(findRealClockToday(readSpecs(REPO_ROOT)));
    expect(
      [...LEGACY_REAL_CLOCK_TODAY.keys()].filter((path) => !found.has(path)),
    ).toEqual([]);
  });
});
