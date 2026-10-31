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
import { isCheckedSpec, readSpecs, type SpecSource } from './bare-delete-many';

// DX-449 (TST-053): los specs de agenda y reservas calculaban «hoy» con el
// reloj real y la zona fija de Bogotá; entre las 04:40 y las 06:00 UTC (la
// medianoche de la sede, cuando el loop fusiona) sus citas «de hoy que ya
// empezaron» caían en ayer o se solapaban. Un spec nuevo que hable de «hoy»
// (un identificador con today/TODAY) y lea el reloj real (`Date.now()` o
// `new Date()`) tiene que pasar por `test/support/sede-clock.ts`
// (`sedeTodayFixture`, `fixedSedeDay`, `civilDaysSince`) o por el reloj
// inyectado del módulo.

const REPO_ROOT = join(__dirname, '..', '..');

/**
 * Lista blanca: specs anteriores a DX-449 que nombran «hoy» y leen el reloj
 * real sin sede-clock. Justificación: ninguno aparece en las runs rojas de la
 * franja 04:40–06:00 UTC que cita TST-053 y su «hoy» no exige citas ya
 * empezadas en la sede; quedan para migrar (ver informe de DX-449). Solo puede
 * bajar: cada entrada tiene que seguir cumpliendo el patrón (un spec migrado
 * sale de aquí) y un spec nuevo no entra.
 */
const LEGACY_REAL_CLOCK_TODAY: ReadonlySet<string> = new Set([
  'test/appointments-medical-alerts.e2e-spec.ts',
  'test/cancellation-fee-protected.e2e-spec.ts',
  'test/cash-register.e2e-spec.ts',
  'test/cash-sessions-concurrency.e2e-spec.ts',
  'test/cash-sessions.e2e-spec.ts',
  'test/clinical-codes.e2e-spec.ts',
  'test/collections-reopen.e2e-spec.ts',
  'test/collections.e2e-spec.ts',
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
  'test/payment-rate-backup.e2e-spec.ts',
  'test/payment-receipt-exchange-rate.e2e-spec.ts',
  'test/plan-items-arrival.e2e-spec.ts',
  'test/receivables.e2e-spec.ts',
  'test/split-payments.e2e-spec.ts',
  'test/collections.int-spec.ts',
  'test/opening-balances.int-spec.ts',
  'test/payment-promise-reopen.int-spec.ts',
  'test/seed-demo.int-spec.ts',
  'test/waitlist-offers.int-spec.ts',
]);

const TODAY_IDENTIFIER = /\b\w*(?:today|Today|TODAY)\w*\b/;
const REAL_CLOCK = /\bDate\.now\(\)|\bnew Date\(\)/;
const SEDE_CLOCK_IMPORT = /from '\.\/support\/sede-clock'/;

/** El código sin comentarios: un «today» en prosa no cuenta. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Specs con BD que nombran «hoy», leen el reloj real y no usan sede-clock. */
export function findRealClockToday(specs: SpecSource[]): string[] {
  return specs
    .filter((s) => isCheckedSpec(s.path))
    .filter((s) => {
      const body = code(s.source);
      return (
        TODAY_IDENTIFIER.test(body) &&
        REAL_CLOCK.test(body) &&
        !SEDE_CLOCK_IMPORT.test(s.source)
      );
    })
    .map((s) => s.path)
    .sort();
}

describe('DX-449: «hoy» de la sede en los specs de agenda y reservas', () => {
  describe('safeTodayZone', () => {
    it('es Bogotá cuando su medianoche queda lejos', () => {
      // 12:00 en Bogotá.
      expect(safeTodayZone(new Date('2026-10-31T17:00:00Z'))).toBe(
        SEDE_FIXTURE_ZONE,
      );
    });

    it.each([
      '2026-10-31T04:40:00Z',
      '2026-10-31T05:01:00Z',
      '2026-10-31T05:30:00Z',
      '2026-10-31T05:56:00Z',
      '2026-10-31T07:30:00Z',
    ])(
      'cerca de la medianoche de Bogotá (%s) elige una zona lejos de la suya',
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
      for (const iso of ['2026-10-31T05:01:00Z', '2026-10-31T05:56:00Z']) {
        const now = new Date(iso);
        const { timeZone } = sedeTodayFixture(now);
        const before = new Date(now.getTime() - 179 * 60_000);
        expect(civilDateIn(before, timeZone)).toBe(civilDateIn(now, timeZone));
      }
    });
  });

  it('civilDaysSince da uno o dos días civiles, del más antiguo al último', () => {
    expect(
      civilDaysSince(60, SEDE_FIXTURE_ZONE, new Date('2026-10-31T17:00:00Z')),
    ).toEqual(['2026-10-31']);
    expect(
      civilDaysSince(60, SEDE_FIXTURE_ZONE, new Date('2026-10-31T05:20:00Z')),
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
        source: "const TODAY = civilDateIn(new Date(), 'America/Bogota');",
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
