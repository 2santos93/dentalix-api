import { minuteText } from './minute-text';
import { regionalFormat } from './regional-format';

const H23 = regionalFormat({ locale: 'de-DE', hourCycle: 'h23' });
const H12 = regionalFormat({ locale: 'en-US', hourCycle: 'h12' });

describe('minuteText (DX-354)', () => {
  it('24 h: 00:00 al principio y 24:00 al fin del día', () => {
    expect(minuteText(0, H23)).toBe('00:00');
    expect(minuteText(1440, H23)).toBe('24:00');
    expect(minuteText(13 * 60 + 5, H23)).toBe('13:05');
  });

  it('12 h: la medianoche inicial es 12:00 a. m. y el fin del día «medianoche», nunca la misma hora dos veces', () => {
    expect(minuteText(0, H12)).toBe('12:00 a. m.');
    expect(minuteText(1440, H12)).toBe('medianoche');
    expect(minuteText(13 * 60 + 5, H12)).toBe('1:05 p. m.');
  });
});
