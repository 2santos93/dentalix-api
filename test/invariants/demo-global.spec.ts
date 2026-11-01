import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CountryCode,
  parsePhoneNumberFromString,
} from 'libphonenumber-js/max';
import {
  daysAgoAt,
  planAppointments,
  planComparisonHistory,
  planInClinicToday,
  planSiteAppointments,
} from '../../prisma/demo/calendar';
import {
  DEMO_COMMUNICATION,
  DEMO_COMPARISON_HISTORY,
  DEMO_LOCATIONS,
  DEMO_MANUAL_RATES,
  DEMO_PATIENTS,
  DEMO_PLANS,
  DEMO_PRICES,
  DEMO_PRIVACY_POLICY,
  DEMO_RESPONSIBLES,
  DEMO_SITE_PRICE_LISTS,
  DEMO_USERS,
  type DemoLocationKey,
  demoRateDates,
  localPatientIndexes,
  sitePatientIndexes,
} from '../../prisma/demo/data';
import { MANUAL_RATE_MAX_DECIMALS } from '../../src/modules/exchange/domain/exchange-rate-source';
import { DEFAULT_BUSINESS_HOURS } from '../../src/shared/locations/default-business-hours';
import { decimalPlaces } from '../../src/shared/validation/bounded-decimal';
import {
  addCivilDays,
  civilDateIn,
  civilWeekday,
} from '../../src/shared/time/civil-day';

// DX-335 (G6.1): la demo es una clínica de varios países y nada de ella
// presupone uno. Este fichero reúne los invariantes de esos datos; cada tarea
// de DX-335 añade aquí los suyos. Corre en `npm test` (`test/invariants` está
// en `roots` de jest) y no necesita base de datos.

// Región de la sede principal: los teléfonos de la hoja y el fijo de DX-128
// se validan con la región con la que los lee la demo.
const MAIN_REGION = DEMO_LOCATIONS.principal.country as CountryCode;
const SITES = Object.values(DEMO_LOCATIONS);
const SITE_KEYS = Object.keys(DEMO_LOCATIONS) as DemoLocationKey[];
// Horario de cada sede: el suyo o, sin él, el del registro (la principal).
const rangesOf = (key: DemoLocationKey) =>
  DEMO_LOCATIONS[key].schedule ?? DEFAULT_BUSINESS_HOURS;

// Apellidos retirados (A6, A7, A11-A22). Los literales se arman por partes
// para que este fichero no se delate solo.
const RETIRED_NAME = new RegExp(
  [
    'Restr' + 'epo',
    'Osp' + 'ina',
    'Mont' + 'oya',
    'Arango',
    'Duq' + 'ue',
    'Hen' + 'ao',
    'Londo' + 'ño',
    'Pinz' + 'ón',
    'Cifu' + 'entes',
    'Zap' + 'ata',
    'Villam' + 'izar',
    'Cast' + 'año',
    'Marth' + 'a Lucía',
    'Luis ' + 'Fernando',
    'Paula ' + 'Andrea',
  ].join('|'),
);

// Lista neutra de R5: la única de apellidos de la hoja de importación.
const NEUTRAL_SURNAMES = [
  'González',
  'Rodríguez',
  'Pérez',
  'Hernández',
  'García',
  'Martínez',
  'López',
  'Díaz',
  'Sánchez',
  'Romero',
  'Torres',
  'Flores',
  'Rivas',
  'Mendoza',
  'Rangel',
  'Paredes',
  'Contreras',
  'Medina',
  'Castillo',
  'Silva',
  'Navarro',
  'Salazar',
  'Herrera',
  'Ortega',
  'Vargas',
  'Rojas',
  'Molina',
  'Suárez',
  'Acosta',
];

// Hoja de importación: columnas separadas por «;» (la línea 1 es la cabecera).
const IMPORT_SHEET = join(
  __dirname,
  '..',
  '..',
  'prisma',
  'demo',
  'pacientes-importacion-ejemplo.csv',
);
const importRows = () =>
  readFileSync(IMPORT_SHEET, 'utf8')
    .split('\n')
    .map((line) => line.split(';'));

describe('demo global (DX-335)', () => {
  it('the demo privacy policy is the DX-325 neutral template', () => {
    const texts = [
      DEMO_PRIVACY_POLICY.policyText,
      DEMO_PRIVACY_POLICY.generalText,
      DEMO_PRIVACY_POLICY.sensitiveHealthText,
      DEMO_PRIVACY_POLICY.marketingText,
    ];
    for (const text of texts) {
      expect(text).not.toContain('[');
      expect(text).not.toContain(']');
      expect(text).not.toMatch(/titular|autoridad|normativa|seg[uú]n la ley/i);
    }
    expect(
      DEMO_PRIVACY_POLICY.policyText.startsWith('Responsable del tratamiento'),
    ).toBe(true);
  });

  it('the import sheet example phones are valid with the main location region, except the error row', () => {
    const rows = importRows();
    for (let line = 2; line <= 26; line++) {
      const cell = rows[line - 1][6];
      if (line === 24 || cell === '') continue;
      expect(parsePhoneNumberFromString(cell, MAIN_REGION)?.isValid()).toBe(
        true,
      );
    }
    expect(
      parsePhoneNumberFromString(rows[23][6], MAIN_REGION)?.isValid() ?? false,
    ).toBe(false);
  });

  it('no demo person keeps a name of the retired set', () => {
    const names = [
      ...DEMO_USERS.map((user) => user.fullName),
      ...DEMO_PATIENTS.flatMap((patient) => [
        patient.firstName,
        patient.lastName,
        patient.emergencyContactName ?? '',
      ]),
      ...DEMO_RESPONSIBLES.map(
        (responsible) => responsible.contact?.fullName ?? '',
      ),
    ];
    for (const name of names) {
      expect(name).not.toMatch(RETIRED_NAME);
    }
  });

  it('the import sheet uses only the neutral surname list', () => {
    const rows = importRows();
    for (let line = 2; line <= 21; line++) {
      const [, , firstName, surnames] = rows[line - 1];
      for (const word of surnames.split(' ')) {
        expect(NEUTRAL_SURNAMES).toContain(word);
      }
      expect(['Jerónimo', 'Salomé']).not.toContain(firstName);
    }
    expect(rows[24][6]).toBe('+55 11 95555 0399');
  });

  it('the DX-128 fixed-line example is a valid fixed line', () => {
    const phone = DEMO_COMMUNICATION[4].input.phone;
    expect(parsePhoneNumberFromString(phone, MAIN_REGION)?.getType()).toBe(
      'FIXED_LINE',
    );
  });

  it('daysAgoAt follows daylight saving time in the location zone', () => {
    const march = new Date('2027-03-24T12:00:00Z');
    const october = new Date('2027-10-27T12:00:00Z');
    expect(daysAgoAt(march, -5, 9 * 60, 'Europe/London').toISOString()).toBe(
      '2027-03-29T08:00:00.000Z',
    );
    expect(daysAgoAt(march, 2, 9 * 60, 'Europe/London').toISOString()).toBe(
      '2027-03-22T09:00:00.000Z',
    );
    expect(daysAgoAt(october, -5, 9 * 60, 'Europe/London').toISOString()).toBe(
      '2027-11-01T09:00:00.000Z',
    );
    expect(daysAgoAt(october, 2, 9 * 60, 'Europe/London').toISOString()).toBe(
      '2027-10-25T08:00:00.000Z',
    );
    expect(
      daysAgoAt(
        new Date('2026-11-01T12:00:00Z'),
        0,
        9 * 60,
        'America/Caracas',
      ).toISOString(),
    ).toBe('2026-11-01T13:00:00.000Z');
  });

  it('the in-clinic planner reads the minute of the day in the location zone', () => {
    // Lunes 2026-11-02 a las 10:00 en Caracas: la que «llegó antes» va a +10 min.
    const now = new Date('2026-11-02T14:00:00Z');
    const [early] = planInClinicToday(
      now,
      DEFAULT_BUSINESS_HOURS,
      'America/Caracas',
    );
    expect(early.start.toISOString()).toBe('2026-11-02T14:10:00.000Z');
    // Fuera de UTC−4, donde un desfase fijo se delata: lunes 2027-06-07 a
    // las 10:00 en Londres (BST, UTC+1).
    const [earlyLondon] = planInClinicToday(
      new Date('2027-06-07T09:00:00Z'),
      DEFAULT_BUSINESS_HOURS,
      'Europe/London',
    );
    expect(earlyLondon.start.toISOString()).toBe('2027-06-07T09:10:00.000Z');
  });

  it('the demo calendar is a pure function of now', () => {
    const now = new Date('2026-11-04T15:00:00Z');
    const zones = {
      principal: DEMO_LOCATIONS.principal.timeZone,
      norte: DEMO_LOCATIONS.norte.timeZone,
    };
    const indexes = localPatientIndexes();
    const plan = () => planAppointments(now, zones, indexes, () => true);
    expect(plan()).toEqual(plan());
  });
  it('the demo locations span at least three countries, currencies, zones and locales', () => {
    for (const field of [
      'country',
      'currency',
      'timeZone',
      'locale',
    ] as const) {
      expect({
        field,
        distinct: new Set(SITES.map((site) => site[field])).size >= 3,
      }).toEqual({ field, distinct: true });
    }
  });

  it('no demo location is in a retired country', () => {
    const retired = ['C' + 'O', 'E' + 'S'];
    expect(SITES.filter((site) => retired.includes(site.country))).toEqual([]);
  });

  it('some demo location uses a locale that is not Spanish', () => {
    expect(SITES.some((site) => site.locale.split('-')[0] !== 'es')).toBe(true);
  });

  it('every currency of a location or a payment is USD or has a manual rate', () => {
    const currencies = [
      ...SITES.map((site) => site.currency),
      ...DEMO_PLANS.flatMap((plan) =>
        plan.payments.flatMap((payment) =>
          payment.currency ? [payment.currency] : [],
        ),
      ),
    ];
    for (const currency of currencies) {
      expect({
        currency,
        rated: currency === 'USD' || currency in DEMO_MANUAL_RATES,
      }).toEqual({ currency, rated: true });
    }
  });

  it("every demo phone is valid and belongs to its patient's location region", () => {
    const checks: { phone: string; region: string; foreign: boolean }[] = [];
    for (const patient of DEMO_PATIENTS) {
      const region = DEMO_LOCATIONS[patient.location].country;
      const foreign = patient.docNumber === 'DEMO-P01';
      for (const phone of [patient.phone, patient.emergencyContactPhone]) {
        if (phone) checks.push({ phone, region, foreign });
      }
    }
    for (const responsible of DEMO_RESPONSIBLES) {
      if (!responsible.contact) continue;
      const patient = DEMO_PATIENTS[responsible.patientIndex];
      checks.push({
        phone: responsible.contact.phone,
        region: DEMO_LOCATIONS[patient.location].country,
        foreign: false,
      });
    }
    for (const site of SITES) {
      if (site.phone) {
        checks.push({
          phone: site.phone,
          region: site.country,
          foreign: false,
        });
      }
    }
    for (const { input } of DEMO_COMMUNICATION) {
      if ('phone' in input) {
        checks.push({
          phone: input.phone,
          region: MAIN_REGION,
          foreign: false,
        });
      }
    }
    expect(checks.length).toBeGreaterThan(DEMO_PATIENTS.length);
    for (const { phone, region, foreign } of checks) {
      const parsed = parsePhoneNumberFromString(phone, region as CountryCode);
      expect({ phone, valid: parsed?.isValid() ?? false }).toEqual({
        phone,
        valid: true,
      });
      if (!foreign) {
        expect({ phone, country: parsed?.country }).toEqual({
          phone,
          country: region,
        });
      }
    }
  });

  it('every manual rate is positive and has at most the decimals the use case accepts', () => {
    for (const [currency, rateOf] of Object.entries(DEMO_MANUAL_RATES)) {
      for (let daysAgo = 0; daysAgo <= 61; daysAgo++) {
        const rate = rateOf(daysAgo);
        expect({
          currency,
          daysAgo,
          positive: rate > 0,
          decimals: decimalPlaces(rate) <= MANUAL_RATE_MAX_DECIMALS,
        }).toEqual({ currency, daysAgo, positive: true, decimals: true });
      }
    }
  });

  it('no planned appointment joins a patient or a dentist with a location that is not theirs', () => {
    const now = new Date('2026-11-02T15:00:00Z');
    const zones = {
      principal: DEMO_LOCATIONS.principal.timeZone,
      norte: DEMO_LOCATIONS.norte.timeZone,
    };
    const rotation = planAppointments(
      now,
      zones,
      localPatientIndexes(),
      () => true,
    );
    expect(rotation.length).toBeGreaterThan(0);
    for (const a of rotation) {
      expect({
        location: a.location,
        patientLocation: DEMO_PATIENTS[a.patientIndex].location,
      }).toEqual({
        location: expect.stringMatching(/^(principal|norte)$/) as string,
        patientLocation: expect.stringMatching(/^(principal|norte)$/) as string,
      });
    }
    for (const key of ['saoPaulo', 'londres'] as const) {
      const site = planSiteAppointments(
        now,
        key,
        DEMO_LOCATIONS[key].timeZone,
        sitePatientIndexes(key),
        () => true,
      );
      expect(site.length).toBeGreaterThan(0);
      for (const a of site) {
        expect({
          location: a.location,
          dentistIndex: a.dentistIndex,
          patientLocation: DEMO_PATIENTS[a.patientIndex].location,
        }).toEqual({ location: key, dentistIndex: 0, patientLocation: key });
      }
    }
    // La historia de «Comparar sedes», con los pacientes de cada sede.
    for (const key of SITE_KEYS) {
      const history = planComparisonHistory(
        now,
        DEMO_LOCATIONS[key].timeZone,
        key,
        DEMO_COMPARISON_HISTORY,
        rangesOf(key),
      );
      expect({ key, visits: history.length > 0 }).toEqual({
        key,
        visits: true,
      });
      for (const visit of history) {
        const patientLocation = DEMO_PATIENTS[visit.patientIndex].location;
        expect({
          location: visit.location,
          patientLocation:
            key === 'principal' || key === 'norte'
              ? ['principal', 'norte'].includes(patientLocation)
              : patientLocation,
        }).toEqual({
          location: key,
          patientLocation: key === 'principal' || key === 'norte' ? true : key,
        });
      }
    }
  });

  it('rates are registered up to the most advanced location today from a location whose today admits them', () => {
    // 21:30 del 31 de octubre en Caracas y ya 01:30 del 1 de noviembre en Londres.
    const dates = demoRateDates(new Date('2026-11-01T01:30:00Z'));
    expect(dates).toHaveLength(62);
    expect(dates[0].date).toBe('2026-09-01');
    expect(dates.at(-1)).toEqual({ date: '2026-11-01', key: 'londres' });
    dates.forEach(({ date, key }, i) => {
      expect(date).toBe(addCivilDays('2026-09-01', i));
      if (i < 61) expect({ date, key }).toEqual({ date, key: 'principal' });
    });
  });

  it('every location tariff has every demo price code, derived from USD', () => {
    expect(DEMO_SITE_PRICE_LISTS.map((list) => list.currency).sort()).toEqual([
      'BRL',
      'GBP',
    ]);
    const codes = Object.keys(DEMO_PRICES).sort();
    expect(codes).toHaveLength(26);
    const rule: Record<string, (usd: number) => number> = {
      BRL: (usd) => Math.round((usd * 3) / 10) * 10,
      GBP: (usd) => Math.round((usd * 0.8) / 5) * 5,
    };
    for (const list of DEMO_SITE_PRICE_LISTS) {
      expect({
        list: list.name,
        codes: Object.keys(list.prices).sort(),
      }).toEqual({ list: list.name, codes });
      expect(list.currency).toBe(DEMO_LOCATIONS[list.locationKey].currency);
      for (const code of codes) {
        expect({ code, price: list.prices[code] }).toEqual({
          code,
          price: rule[list.currency](DEMO_PRICES[code]),
        });
      }
    }
    const byCurrency = (currency: string) =>
      DEMO_SITE_PRICE_LISTS.find((list) => list.currency === currency)!;
    expect(byCurrency('BRL').prices['IMG-CONSULTA']).toBe(240);
    expect(byCurrency('GBP').prices['IMG-CONSULTA']).toBe(65);
  });

  it('the comparison history of a location uses the calendar months of its zone', () => {
    // 21:30 del 31 de octubre en Caracas y ya 01:30 del 1 de noviembre en Londres.
    const now = new Date('2026-11-01T01:30:00Z');
    const visitMonths = (zone: string) => {
      const visits = planComparisonHistory(
        now,
        zone,
        'londres',
        DEMO_COMPARISON_HISTORY,
        rangesOf('londres'),
      );
      // Cada visita, en el calendario de la zona con la que se planificó.
      const monthOf = (v: (typeof visits)[number]) =>
        civilDateIn(daysAgoAt(now, v.daysAgo, v.startMinute, zone), zone).slice(
          0,
          7,
        );
      return {
        previous: visits.filter((v) => v.month === 'previous').map(monthOf),
        current: visits.filter((v) => v.month === 'current').map(monthOf),
      };
    };
    const london = visitMonths(DEMO_LOCATIONS.londres.timeZone);
    expect(london.previous.length).toBeGreaterThan(0);
    expect(london.previous.every((m) => m === '2026-10')).toBe(true);
    expect(london.current.every((m) => m === '2026-11')).toBe(true);
    // Control: con la zona de la principal, el «mes anterior» es septiembre.
    const main = visitMonths(DEMO_LOCATIONS.principal.timeZone);
    expect(main.previous.length).toBeGreaterThan(0);
    expect(main.previous.every((m) => m === '2026-09')).toBe(true);
  });

  it('comparison history never anchors on a day its location is closed', () => {
    let checked = 0;
    for (
      let day = '2028-01-01';
      day <= '2028-12-31';
      day = addCivilDays(day, 1)
    ) {
      const now = new Date(`${day}T12:00:00Z`);
      for (const key of SITE_KEYS) {
        const zone = DEMO_LOCATIONS[key].timeZone;
        const ranges = rangesOf(key);
        for (const visit of planComparisonHistory(
          now,
          zone,
          key,
          DEMO_COMPARISON_HISTORY,
          ranges,
        )) {
          const visitDay = addCivilDays(civilDateIn(now, zone), -visit.daysAgo);
          const weekday = civilWeekday(visitDay);
          const fits = ranges.some(
            (r) =>
              r.weekday === weekday &&
              r.startMinute <= visit.startMinute &&
              visit.startMinute + visit.durationMinutes <= r.endMinute,
          );
          if (!fits) {
            expect({ key, day, visitDay, visit }).toEqual(
              'a slot inside its schedule',
            );
          }
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(366 * 4);
  });
});
