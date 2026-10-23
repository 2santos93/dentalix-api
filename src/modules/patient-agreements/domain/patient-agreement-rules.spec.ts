import { patientAgreementStatus } from './patient-agreement-rules';

const TODAY = '2026-10-20';
const agreement = (extra: object = {}) => ({
  active: true,
  validFrom: null,
  validTo: null,
  ...extra,
});

describe('patientAgreementStatus', () => {
  const status = (
    a: Partial<{ active: boolean; validFrom: string; validTo: string }>,
    own: { validFrom?: string | null; validTo?: string | null } = {},
  ) =>
    patientAgreementStatus(
      {
        agreement: agreement(a),
        validFrom: own.validFrom ?? null,
        validTo: own.validTo ?? null,
      },
      TODAY,
    );

  it('sin fechas es ACTIVE', () => {
    expect(status({})).toBe('ACTIVE');
  });

  it('los extremos cuentan como vigentes', () => {
    expect(status({ validTo: TODAY }, { validFrom: TODAY })).toBe('ACTIVE');
  });

  it('INACTIVE gana sobre cualquier vigencia', () => {
    expect(status({ active: false, validTo: '2020-01-01' })).toBe('INACTIVE');
  });

  it('vence si CUALQUIERA de las dos vigencias terminó', () => {
    expect(status({ validTo: '2026-10-19' })).toBe('EXPIRED');
    expect(status({}, { validTo: '2026-10-19' })).toBe('EXPIRED');
  });

  it('no empezó si CUALQUIERA de las dos empieza después', () => {
    expect(status({ validFrom: '2026-10-21' })).toBe('NOT_STARTED');
    expect(status({}, { validFrom: '2026-10-21' })).toBe('NOT_STARTED');
  });

  it('con una vencida y otra sin empezar, gana EXPIRED (como coverageStatus)', () => {
    expect(status({ validTo: '2026-10-19' }, { validFrom: '2026-10-21' })).toBe(
      'EXPIRED',
    );
  });
});
