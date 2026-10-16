import { DentitionType } from '@prisma/client';
import {
  PERMANENT_POSITIONS,
  ageInYears,
  dentitionByAge,
  overallDentition,
  positionOfTooth,
  resolveDentition,
  toothAllowedIn,
} from './dentition';

const { PERMANENT, PRIMARY, MIXED } = DentitionType;

describe('dentición (DX-120)', () => {
  describe('positionOfTooth', () => {
    it('un temporal ocupa la posición de su sucesor permanente', () => {
      expect(positionOfTooth('55')).toBe('15');
      expect(positionOfTooth('64')).toBe('24');
      expect(positionOfTooth('71')).toBe('31');
      expect(positionOfTooth('85')).toBe('45');
    });

    it('un permanente es su propia posición', () => {
      expect(positionOfTooth('16')).toBe('16');
      expect(positionOfTooth('48')).toBe('48');
    });
  });

  describe('ageInYears', () => {
    it('cumple años el mismo día del calendario', () => {
      expect(ageInYears('2019-10-16', '2026-10-16')).toBe(7);
      expect(ageInYears('2019-10-17', '2026-10-16')).toBe(6);
    });

    it('nacido el 29 de febrero cumple el 1 de marzo en año no bisiesto', () => {
      expect(ageInYears('2020-02-29', '2027-02-28')).toBe(6);
      expect(ageInYears('2020-02-29', '2027-03-01')).toBe(7);
    });
  });

  describe('dentitionByAge (límites 5/6/12/13 años)', () => {
    it('con 5 años, todo temporal', () => {
      for (const position of PERMANENT_POSITIONS) {
        expect(dentitionByAge(position, 5)).toBe(PRIMARY);
      }
    });

    it('con 6 años ya es mixta: primeros molares e incisivo central inferior', () => {
      expect(dentitionByAge('16', 6)).toBe(PERMANENT);
      expect(dentitionByAge('46', 6)).toBe(PERMANENT);
      expect(dentitionByAge('31', 6)).toBe(MIXED);
      expect(dentitionByAge('11', 6)).toBe(PRIMARY);
      expect(dentitionByAge('15', 6)).toBe(PRIMARY);
    });

    it('con 7 años, el incisivo central superior está mudando y el inferior ya es permanente', () => {
      expect(dentitionByAge('11', 7)).toBe(MIXED);
      expect(dentitionByAge('41', 7)).toBe(PERMANENT);
      expect(dentitionByAge('15', 7)).toBe(PRIMARY);
    });

    it('con 12 años sigue mixta (terceros molares sin erupcionar)', () => {
      expect(dentitionByAge('13', 12)).toBe(PERMANENT);
      expect(dentitionByAge('17', 12)).toBe(PERMANENT);
      expect(dentitionByAge('18', 12)).toBe(PRIMARY);
    });

    it('con 13 años, todo permanente', () => {
      for (const position of PERMANENT_POSITIONS) {
        expect(dentitionByAge(position, 13)).toBe(PERMANENT);
      }
    });
  });

  describe('overallDentition', () => {
    it('resume la carta: temporal, permanente o mixta', () => {
      expect(overallDentition([PRIMARY, PRIMARY])).toBe(PRIMARY);
      expect(overallDentition([PERMANENT, PERMANENT])).toBe(PERMANENT);
      expect(overallDentition([PERMANENT, PRIMARY])).toBe(MIXED);
      expect(overallDentition([MIXED])).toBe(MIXED);
    });
  });

  describe('resolveDentition', () => {
    const birthDate = new Date('2019-10-16T00:00:00.000Z');

    it('un niño de 7 años sin eventos: mixta por la edad', () => {
      const out = resolveDentition({
        birthDate,
        onDate: '2026-10-16',
        events: [],
      });
      expect(out.basis).toBe('AGE');
      expect(out.ageYears).toBe(7);
      expect(out.overall).toBe(MIXED);
      expect(out.positions).toHaveLength(32);
      expect(out.positions.find((p) => p.position === '11')).toMatchObject({
        dentition: MIXED,
        source: 'AGE',
      });
    });

    it('un niño de 4 años: temporal; un adulto: permanente', () => {
      expect(
        resolveDentition({
          birthDate: new Date('2022-05-01T00:00:00.000Z'),
          onDate: '2026-10-16',
          events: [],
        }).overall,
      ).toBe(PRIMARY);
      expect(
        resolveDentition({
          birthDate: new Date('1990-01-01T00:00:00.000Z'),
          onDate: '2026-10-16',
          events: [],
        }).overall,
      ).toBe(PERMANENT);
    });

    it('sin fecha de nacimiento: permanente por defecto', () => {
      const out = resolveDentition({
        birthDate: null,
        onDate: '2026-10-16',
        events: [],
      });
      expect(out.basis).toBe('DEFAULT');
      expect(out.ageYears).toBeNull();
      expect(out.overall).toBe(PERMANENT);
      expect(out.positions[0].source).toBe('DEFAULT');
    });

    it('el último evento de cada posición manda sobre la edad', () => {
      const out = resolveDentition({
        birthDate,
        onDate: '2026-10-16',
        events: [
          {
            id: 'e1',
            position: '15',
            dentition: PERMANENT,
            reason: 'EXFOLIATION',
            recordedAt: new Date('2026-10-10T10:00:00Z'),
            performedById: 'u1',
          },
          {
            id: 'e2',
            position: '15',
            dentition: MIXED,
            reason: 'MANUAL',
            recordedAt: new Date('2026-10-11T10:00:00Z'),
            performedById: 'u1',
          },
        ],
      });
      const p15 = out.positions.find((p) => p.position === '15');
      expect(p15).toMatchObject({ dentition: MIXED, source: 'EVENT' });
      expect(p15?.lastEvent?.id).toBe('e2');
    });
  });

  describe('toothAllowedIn', () => {
    it('una posición PERMANENT solo admite el permanente', () => {
      expect(toothAllowedIn('15', PERMANENT)).toBe(true);
      expect(toothAllowedIn('55', PERMANENT)).toBe(false);
    });

    it('una posición PRIMARY solo admite el temporal', () => {
      expect(toothAllowedIn('55', PRIMARY)).toBe(true);
      expect(toothAllowedIn('15', PRIMARY)).toBe(false);
      // Molar sin erupcionar: no hay pieza en la que registrar.
      expect(toothAllowedIn('16', PRIMARY)).toBe(false);
    });

    it('una posición MIXED admite los dos', () => {
      expect(toothAllowedIn('55', MIXED)).toBe(true);
      expect(toothAllowedIn('15', MIXED)).toBe(true);
    });
  });
});
