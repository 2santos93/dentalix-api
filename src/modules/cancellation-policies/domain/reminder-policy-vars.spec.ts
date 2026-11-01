import { regionalFormat } from '../../../shared/format/regional-format';
import { reminderPolicyVars } from './reminder-policy-vars';

const policy = (suggestedFee: number | null, currency: string | null) => ({
  noticeHours: 24,
  patientText: 'Avísanos con un día.',
  suggestedFee,
  currency,
});

describe('reminderPolicyVars (DX-291, DX-350)', () => {
  it('policy fee in the reminder uses the location format', () => {
    expect(
      reminderPolicyVars(
        policy(5000, 'JPY'),
        regionalFormat({ locale: 'ja-JP', hourCycle: 'h12' }),
      ),
    ).toEqual({
      noticeHours: 24,
      text: 'Avísanos con un día.',
      feeLabel: '￥5,000',
    });
    expect(
      reminderPolicyVars(
        policy(1234.5, 'EUR'),
        regionalFormat({ locale: 'de-DE', hourCycle: 'h23' }),
      )?.feeLabel,
    ).toMatch(/^1\.234,50\s€$/);
  });

  it('sin importe (o sin moneda) no hay frase del cargo; sin política, null', () => {
    const fmt = regionalFormat({ locale: 'en-US', hourCycle: 'h12' });
    expect(reminderPolicyVars(policy(null, null), fmt)?.feeLabel).toBeNull();
    expect(reminderPolicyVars(policy(0, 'USD'), fmt)?.feeLabel).toBeNull();
    expect(reminderPolicyVars(policy(10, null), fmt)?.feeLabel).toBeNull();
    expect(reminderPolicyVars(null, fmt)).toBeNull();
  });

  it('DX-517: con texto propio para la moneda, ese texto en el lugar del código; sin él, igual', () => {
    const fmt = regionalFormat({ locale: 'es-VE', hourCycle: 'h12' });
    expect(
      reminderPolicyVars(policy(1234.5, 'VES'), fmt, { VES: 'Bs.' })?.feeLabel,
    ).toBe('Bs.\u00a01.234,50');
    expect(
      reminderPolicyVars(policy(1234.5, 'VES'), fmt, { EUR: '€' })?.feeLabel,
    ).toBe(reminderPolicyVars(policy(1234.5, 'VES'), fmt)?.feeLabel);
  });
});
