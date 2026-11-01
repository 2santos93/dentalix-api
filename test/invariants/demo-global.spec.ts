import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import {
  daysAgoAt,
  planAppointments,
  planInClinicToday,
} from '../../prisma/demo/calendar';
import {
  DEMO_COMMUNICATION,
  DEMO_LOCATIONS,
  DEMO_PATIENTS,
  DEMO_PRIVACY_POLICY,
  DEMO_RESPONSIBLES,
  DEMO_USERS,
} from '../../prisma/demo/data';
import { DEFAULT_BUSINESS_HOURS } from '../../src/shared/locations/default-business-hours';

// DX-335 (G6.1): la demo es una clínica de varios países y nada de ella
// presupone uno. Este fichero reúne los invariantes de esos datos; cada tarea
// de DX-335 añade aquí los suyos. Corre en `npm test` (`test/invariants` está
// en `roots` de jest) y no necesita base de datos.

// Región de la sede principal. Literal aquí: los teléfonos de la hoja y el
// fijo de DX-128 se validan con la región con la que los lee la demo.
const MAIN_REGION = 'VE';

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
  });

  it('the demo calendar is a pure function of now', () => {
    const now = new Date('2026-11-04T15:00:00Z');
    const zones = {
      principal: DEMO_LOCATIONS.principal.timeZone,
      norte: DEMO_LOCATIONS.norte.timeZone,
    };
    const indexes = DEMO_PATIENTS.map((_, i) => i);
    const plan = () => planAppointments(now, zones, indexes, () => true);
    expect(plan()).toEqual(plan());
  });
});
