import { consentEvidenceFrom } from './consent-evidence';

describe('consentEvidenceFrom', () => {
  it('toma la IP que calcula Express (respeta trust proxy) y el user-agent', () => {
    expect(
      consentEvidenceFrom({
        ip: '203.0.113.7',
        headers: { 'user-agent': 'Mozilla/5.0' },
      }),
    ).toEqual({ ipAddress: '203.0.113.7', userAgent: 'Mozilla/5.0' });
  });

  it('omite lo que la petición no trae', () => {
    expect(consentEvidenceFrom({ ip: undefined, headers: {} })).toEqual({});
  });
});
