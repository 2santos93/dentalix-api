import { ClinicRole } from '@prisma/client';
import {
  coverageTrustedFor,
  isExternalPayer,
  patientAgreementStatus,
} from './patient-agreement-rules';

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

describe('isExternalPayer (SEC-047)', () => {
  it('aseguradoras, planes prepago, sistemas públicos y empresas son pagadores externos', () => {
    for (const type of [
      'INSURER',
      'PREPAID_PLAN',
      'PUBLIC_SYSTEM',
      'EMPLOYER',
    ] as const) {
      expect(isExternalPayer(type)).toBe(true);
    }
  });

  it('OTHER es un convenio interno (cortesía, empleados)', () => {
    expect(isExternalPayer('OTHER')).toBe(false);
  });
});

describe('coverageTrustedFor (SEC-049)', () => {
  const ME = 'user-me';
  const OTHER = 'user-other';
  const coverage = (
    extra: Partial<{
      verifiedAt: Date | null;
      declaredById: string | null;
      migratedFromLegacyInsurer: boolean;
    }> = {},
  ) => ({
    verifiedAt: null,
    declaredById: ME,
    migratedFromLegacyInsurer: false,
    ...extra,
  });
  const NON_ADMIN = [
    ClinicRole.DENTIST,
    ClinicRole.ASSISTANT,
    ClinicRole.RECEPTION,
  ] as const;

  it('ADMIN asigna con cualquier cobertura, aunque la registrara él y sin verificar', () => {
    expect(
      coverageTrustedFor(coverage(), { userId: ME, role: ClinicRole.ADMIN }),
    ).toBe(true);
  });

  it.each(NON_ADMIN)(
    '%s: la que registró él mismo, sin verificar, no vale',
    (role) => {
      expect(coverageTrustedFor(coverage(), { userId: ME, role })).toBe(false);
    },
  );

  it.each(NON_ADMIN)('%s: verificada por un ADMIN, vale', (role) => {
    expect(
      coverageTrustedFor(coverage({ verifiedAt: new Date() }), {
        userId: ME,
        role,
      }),
    ).toBe(true);
  });

  it.each(NON_ADMIN)('%s: registrada por otro usuario, vale', (role) => {
    expect(
      coverageTrustedFor(coverage({ declaredById: OTHER }), {
        userId: ME,
        role,
      }),
    ).toBe(true);
  });

  it('cobertura MIGRADA del texto libre de aseguradora anterior a DX-153 o sin autor conocido, vale', () => {
    const actor = { userId: ME, role: ClinicRole.RECEPTION };
    expect(
      coverageTrustedFor(coverage({ migratedFromLegacyInsurer: true }), actor),
    ).toBe(true);
    expect(coverageTrustedFor(coverage({ declaredById: null }), actor)).toBe(
      true,
    );
  });
});
