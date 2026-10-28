import { civilDateIn } from '../../../shared/time/civil-day';
import {
  ageForSnapshot,
  roundWeightKg,
  weightForSnapshot,
} from './patient-snapshot';

describe('patient snapshot', () => {
  it('an impossible age (future birth date, 1850) snapshots null', () => {
    expect(ageForSnapshot(new Date('2030-01-01'), '2027-05-03')).toBeNull();
    expect(ageForSnapshot(new Date('1850-01-01'), '2027-05-03')).toBeNull();
  });

  it('born today in a zone that is still yesterday at the location snapshots null, not -1', () => {
    // La fecha de nacimiento es el 4 en la zona del registro; la sede todavía
    // vive el 3: `ageInYears` daría −1.
    expect(ageForSnapshot(new Date('2027-05-04'), '2027-05-03')).toBeNull();
  });

  it('born on the location day is 0', () => {
    expect(ageForSnapshot(new Date('2027-05-03'), '2027-05-03')).toBe(0);
  });

  it('the same instant, a newborn of Tokyo day: 0 in Tokyo, null in New York', () => {
    // 2027-05-04T02:00Z es el 4 en Tokio y aún el 3 en Nueva York.
    const instant = new Date('2027-05-04T02:00:00.000Z');
    const birth = new Date('2027-05-04');
    expect(ageForSnapshot(birth, civilDateIn(instant, 'Asia/Tokyo'))).toBe(0);
    expect(
      ageForSnapshot(birth, civilDateIn(instant, 'America/New_York')),
    ).toBeNull();
  });

  it('the age bounds are 0 and 150, both kept', () => {
    expect(ageForSnapshot(new Date('1877-05-03'), '2027-05-03')).toBe(150);
    expect(ageForSnapshot(new Date('1876-05-04'), '2027-05-03')).toBe(150);
    expect(ageForSnapshot(new Date('1876-05-03'), '2027-05-03')).toBeNull();
    expect(ageForSnapshot(new Date('1980-05-04'), '2027-05-03')).toBe(46);
  });

  it('no birth date snapshots null', () => {
    expect(ageForSnapshot(null, '2027-05-03')).toBeNull();
  });

  it('roundWeightKg at the CHECK bounds snapshots null (0.04, 399.96)', () => {
    expect(weightForSnapshot(0.04)).toBeNull();
    expect(weightForSnapshot(399.96)).toBeNull();
    // 72,55 es 725,4999… en binario: redondea a 72,5 (ver prescription-hash.spec).
    expect(weightForSnapshot(72.55)).toBe(72.5);
  });

  it('keeps a weight inside the bounds and drops no weight or a non-finite one', () => {
    expect(weightForSnapshot(0.06)).toBe(0.1);
    expect(weightForSnapshot(399.94)).toBe(399.9);
    expect(weightForSnapshot(null)).toBeNull();
    expect(weightForSnapshot(Number.NaN)).toBeNull();
    expect(weightForSnapshot(Number.POSITIVE_INFINITY)).toBeNull();
    expect(weightForSnapshot(-5)).toBeNull();
  });

  it('roundWeightKg', () => {
    // 72,55 es 72,5499… en binario (×10 = 725,4999…), así que redondea a 72,5.
    // No se «arregla» a 72,6: el peso guardado y el hash de las recetas
    // emitidas dependen de ello.
    expect(roundWeightKg(72.55)).toBe(72.5);
    expect(roundWeightKg(72.56)).toBe(72.6);
    expect(roundWeightKg(18)).toBe(18);
  });
});
