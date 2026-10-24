import {
  CANCELLATION_FEE_MESSAGES,
  blockMessage,
  canManageFee,
  chargeBlockReason,
  epsCoBlockEnabled,
  hasActiveEpsCoverage,
  isFeeEligible,
  normalizeWaiveReason,
  resolveChargeAmount,
  waiveBlockReason,
  type FeeChargeFacts,
} from './cancellation-fee';

const facts = (over: Partial<FeeChargeFacts> = {}): FeeChargeFacts => ({
  appointment: {
    status: 'NO_SHOW',
    lateCancellation: null,
    policyVersionId: 'v1',
  },
  communicated: { suggestedFee: 50000, currency: 'COP' },
  locationCountry: 'CO',
  hasActiveEpsCo: false,
  epsCoBlockEnabled: true,
  existing: null,
  ...over,
});

const fmt = (n: number) => `${n} COP`;

describe('cargo por inasistencia o cancelación tardía (DX-291)', () => {
  describe('isFeeEligible', () => {
    it('una inasistencia o una cancelación tardía se cobran', () => {
      expect(
        isFeeEligible({
          status: 'NO_SHOW',
          lateCancellation: null,
          policyVersionId: null,
        }),
      ).toBe(true);
      expect(
        isFeeEligible({
          status: 'CANCELLED',
          lateCancellation: true,
          policyVersionId: null,
        }),
      ).toBe(true);
    });

    it('una cancelación a tiempo, sin dato de tardía o una cita viva, no', () => {
      for (const appointment of [
        { status: 'CANCELLED', lateCancellation: false },
        { status: 'CANCELLED', lateCancellation: null },
        { status: 'SCHEDULED', lateCancellation: null },
        { status: 'COMPLETED', lateCancellation: null },
      ] as const) {
        expect(isFeeEligible({ ...appointment, policyVersionId: 'v' })).toBe(
          false,
        );
      }
    });
  });

  describe('chargeBlockReason', () => {
    it('sin bloqueos se puede cobrar', () => {
      expect(chargeBlockReason(facts())).toBeNull();
    });

    it('sin versión comunicada: NOT_INFORMED («No consta que el paciente fuera informado…»)', () => {
      const reason = chargeBlockReason(
        facts({
          appointment: {
            status: 'NO_SHOW',
            lateCancellation: null,
            policyVersionId: null,
          },
          communicated: null,
        }),
      );
      expect(reason).toBe('NOT_INFORMED');
      expect(blockMessage(reason!)).toBe(
        'No consta que el paciente fuera informado de la política.',
      );
    });

    it('EPS_CO activa en una sede de Colombia bloquea; en España o con el bloqueo apagado, no', () => {
      expect(chargeBlockReason(facts({ hasActiveEpsCo: true }))).toBe('EPS_CO');
      expect(
        chargeBlockReason(
          facts({ hasActiveEpsCo: true, locationCountry: 'ES' }),
        ),
      ).toBeNull();
      expect(
        chargeBlockReason(
          facts({ hasActiveEpsCo: true, epsCoBlockEnabled: false }),
        ),
      ).toBeNull();
    });

    it('una política comunicada sin importe no tiene nada que cobrar', () => {
      expect(
        chargeBlockReason(
          facts({ communicated: { suggestedFee: null, currency: null } }),
        ),
      ).toBe('NO_FEE');
      expect(
        chargeBlockReason(
          facts({ communicated: { suggestedFee: 0, currency: 'COP' } }),
        ),
      ).toBe('NO_FEE');
    });

    it('ya cobrado o ya condonado: 409 con su mensaje', () => {
      expect(chargeBlockReason(facts({ existing: 'CHARGED' }))).toBe(
        'ALREADY_CHARGED',
      );
      expect(chargeBlockReason(facts({ existing: 'WAIVED' }))).toBe(
        'ALREADY_WAIVED',
      );
      expect(blockMessage('ALREADY_CHARGED')).toBe(
        CANCELLATION_FEE_MESSAGES.alreadyCharged,
      );
    });

    it('una cita que no es inasistencia ni tardía no se cobra', () => {
      expect(
        chargeBlockReason(
          facts({
            appointment: {
              status: 'CANCELLED',
              lateCancellation: false,
              policyVersionId: 'v1',
            },
          }),
        ),
      ).toBe('NOT_ELIGIBLE');
    });
  });

  describe('waiveBlockReason', () => {
    const noShow = {
      status: 'NO_SHOW',
      lateCancellation: null,
      policyVersionId: null,
    } as const;
    it('se puede condonar sin política comunicada, pero solo una vez y antes de cobrar', () => {
      expect(waiveBlockReason(noShow, null)).toBeNull();
      expect(waiveBlockReason(noShow, 'WAIVED')).toBe('ALREADY_WAIVED');
      expect(waiveBlockReason(noShow, 'CHARGED')).toBe('ALREADY_CHARGED');
      expect(waiveBlockReason({ ...noShow, status: 'COMPLETED' }, null)).toBe(
        'NOT_ELIGIBLE',
      );
    });
  });

  describe('resolveChargeAmount', () => {
    it('sin importe usa el sugerido', () => {
      expect(resolveChargeAmount(undefined, 50000, fmt)).toEqual({
        ok: true,
        amount: 50000,
      });
    });

    it('editable a la baja (igual vale)', () => {
      expect(resolveChargeAmount(30000, 50000, fmt)).toEqual({
        ok: true,
        amount: 30000,
      });
      expect(resolveChargeAmount(50000, 50000, fmt)).toEqual({
        ok: true,
        amount: 50000,
      });
    });

    it('nunca por encima del sugerido (400 con el tope)', () => {
      expect(resolveChargeAmount(50000.01, 50000, fmt)).toEqual({
        ok: false,
        message:
          'El importe no puede superar el sugerido por la política comunicada (50000 COP).',
      });
    });

    it('0, negativo, NaN o 3 decimales: 400', () => {
      for (const bad of [0, -1, Number.NaN, 10.123]) {
        expect(resolveChargeAmount(bad, 50000, fmt)).toEqual({
          ok: false,
          message: CANCELLATION_FEE_MESSAGES.amount,
        });
      }
    });
  });

  it('normalizeWaiveReason recorta y exige 3–500 caracteres', () => {
    expect(normalizeWaiveReason('  Enfermedad  ')).toBe('Enfermedad');
    expect(normalizeWaiveReason('ok')).toBeNull();
    expect(normalizeWaiveReason(undefined)).toBeNull();
    expect(normalizeWaiveReason('x'.repeat(501))).toBeNull();
  });

  it('canManageFee: ADMIN siempre; RECEPTION solo si la política lo permite', () => {
    expect(canManageFee('ADMIN', false)).toBe(true);
    expect(canManageFee('RECEPTION', false)).toBe(false);
    expect(canManageFee('RECEPTION', true)).toBe(true);
    expect(canManageFee('DENTIST', true)).toBe(false);
  });

  it('hasActiveEpsCoverage: solo EPS_CO vigente ese día (extremos incluidos)', () => {
    const eps = {
      payerType: 'EPS_CO' as const,
      validFrom: null,
      validTo: null,
    };
    expect(hasActiveEpsCoverage([eps], '2026-10-24')).toBe(true);
    expect(
      hasActiveEpsCoverage([{ ...eps, validTo: '2026-10-24' }], '2026-10-24'),
    ).toBe(true);
    expect(
      hasActiveEpsCoverage([{ ...eps, validTo: '2026-10-23' }], '2026-10-24'),
    ).toBe(false);
    expect(
      hasActiveEpsCoverage(
        [{ ...eps, payerType: 'PREPAGADA_CO' }],
        '2026-10-24',
      ),
    ).toBe(false);
  });

  it('epsCoBlockEnabled: activado salvo «false»', () => {
    expect(epsCoBlockEnabled(undefined)).toBe(true);
    expect(epsCoBlockEnabled('true')).toBe(true);
    expect(epsCoBlockEnabled(' FALSE ')).toBe(false);
  });
});
