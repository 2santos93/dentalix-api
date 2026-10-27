import { endSentence } from './end-sentence';
import { regionalFormat } from './regional-format';

describe('endSentence (G1-B)', () => {
  it('adds the period only when the text does not already end in one', () => {
    expect(endSentence('quedan 10')).toBe('quedan 10.');
    expect(endSentence('a las 3:05 p. m.')).toBe('a las 3:05 p. m.');
  });

  it('an amount whose currency symbol ends in a period is not doubled', () => {
    const money = regionalFormat({ locale: 'ar-EG', hourCycle: 'h12' }).money(
      1234.5,
      'EGP',
    );
    expect(money.endsWith('.')).toBe(true);
    expect(endSentence(`quedan ${money}`)).toBe(`quedan ${money}`);
  });
});
