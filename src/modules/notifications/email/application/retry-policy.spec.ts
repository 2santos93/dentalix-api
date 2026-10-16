import {
  MAX_EMAIL_ATTEMPTS,
  describeDeliveryError,
  retryDelayMs,
} from './retry-policy';

describe('retry-policy', () => {
  it('3 intentos en total', () => {
    expect(MAX_EMAIL_ATTEMPTS).toBe(3);
  });

  it('backoff exponencial con tope de 1 h', () => {
    expect(retryDelayMs(1, 60_000)).toBe(60_000);
    expect(retryDelayMs(2, 60_000)).toBe(120_000);
    expect(retryDelayMs(3, 60_000)).toBe(240_000);
    expect(retryDelayMs(20, 60_000)).toBe(3_600_000);
  });

  it('describe el error sin su mensaje (puede llevar el destinatario)', () => {
    const smtp = Object.assign(
      new Error('550 5.1.1 <ana@clinica.co>: user unknown'),
      { responseCode: 550 },
    );
    expect(describeDeliveryError(smtp)).toBe('Error 550');

    const net = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:25'), {
      code: 'ECONNREFUSED',
    });
    expect(describeDeliveryError(net)).toBe('Error ECONNREFUSED');

    class ProviderTimeout extends Error {
      name = 'ProviderTimeout';
    }
    expect(describeDeliveryError(new ProviderTimeout('ana@x.co'))).toBe(
      'ProviderTimeout',
    );
    expect(describeDeliveryError('ana@x.co')).toBe('UnknownError');
  });

  it('un code con texto libre no se cuela', () => {
    const odd = Object.assign(new Error('x'), { code: 'ana@clinica.co' });
    expect(describeDeliveryError(odd)).toBe('Error');
  });
});
