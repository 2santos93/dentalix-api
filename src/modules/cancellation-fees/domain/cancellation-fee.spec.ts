import {
  CANCELLATION_FEE_MESSAGES,
  blockMessage,
  canManageFee,
  chargeBlockReason,
  isFeeEligible,
  normalizeWaiveReason,
  resolveChargeAmount,
  voidBlockMessage,
  voidPaymentsCheck,
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

    it('chargeBlockReason ignores coverages and location: a NO_SHOW with a communicated fee is chargeable', () => {
      const noShow = {
        status: 'NO_SHOW',
        lateCancellation: null,
        policyVersionId: 'v1',
      } as const;
      expect(
        chargeBlockReason({
          appointment: noShow,
          communicated: { suggestedFee: 50, currency: 'USD' },
          existing: null,
        }),
      ).toBeNull();
    });

    it('block order is ALREADY_CHARGED, ALREADY_WAIVED, NOT_ELIGIBLE, NOT_INFORMED, NO_FEE', () => {
      const notEligible = {
        status: 'CANCELLED',
        lateCancellation: false,
        policyVersionId: null,
      } as const;
      const noFee = { suggestedFee: null, currency: null };
      const cases: [Partial<FeeChargeFacts>, string][] = [
        [
          {
            existing: 'CHARGED',
            appointment: notEligible,
            communicated: null,
          },
          'ALREADY_CHARGED',
        ],
        [
          { existing: 'WAIVED', appointment: notEligible, communicated: null },
          'ALREADY_WAIVED',
        ],
        [{ appointment: notEligible, communicated: null }, 'NOT_ELIGIBLE'],
        [
          {
            appointment: {
              status: 'NO_SHOW',
              lateCancellation: null,
              policyVersionId: null,
            },
            communicated: noFee,
          },
          'NOT_INFORMED',
        ],
        [{ communicated: noFee }, 'NO_FEE'],
      ];
      for (const [over, expected] of cases) {
        expect(chargeBlockReason(facts(over))).toBe(expected);
      }
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

    it('acepta céntimos que no son exactos en coma flotante (19,99 · 1,15 · 0,29)', () => {
      for (const amount of [19.99, 1.15, 0.29, 4.35]) {
        expect(resolveChargeAmount(amount, 25, fmt)).toEqual({
          ok: true,
          amount,
        });
      }
      expect(resolveChargeAmount(1.155, 25, fmt).ok).toBe(false);
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

  describe('voidBlockMessage (SEC-050)', () => {
    it('solo se anula un cargo generado y sin anular', () => {
      expect(
        voidBlockMessage({ status: 'CHARGED', voidedAt: null }),
      ).toBeNull();
    });

    it('sin cargo o con una condonación: «no tiene un cargo generado»', () => {
      expect(voidBlockMessage(null)).toBe(CANCELLATION_FEE_MESSAGES.notCharged);
      expect(voidBlockMessage({ status: 'WAIVED', voidedAt: null })).toBe(
        CANCELLATION_FEE_MESSAGES.notCharged,
      );
    });

    it('ya anulado: «ya se anuló»', () => {
      expect(
        voidBlockMessage({ status: 'CHARGED', voidedAt: new Date() }),
      ).toBe(CANCELLATION_FEE_MESSAGES.alreadyVoided);
    });
  });

  describe('voidPaymentsCheck (DX-382: en la moneda del plan)', () => {
    it('sin abonos vivos se anula', () => {
      expect(voidPaymentsCheck([], 0)).toBe('CLEAR');
      expect(voidPaymentsCheck([], 8_000_000)).toBe('CLEAR');
    });

    it('plan COP, 50 USD (base 200.000 COP) con 100.000 por cobrar sin el cargo: ya cobrado', () => {
      // La suma bruta (50 frente a 100.000) lo dejaba anular.
      expect(voidPaymentsCheck([20_000_000], 10_000_000)).toBe('PAID');
    });

    it('plan USD, 40.000 COP (base 10 USD) con 30 USD por cobrar sin el cargo: se anula', () => {
      // La suma bruta (40.000 frente a 30) lo bloqueaba.
      expect(voidPaymentsCheck([1_000], 3_000)).toBe('CLEAR');
    });

    it('lo cobrado igual a lo que queda se anula; un céntimo más, no', () => {
      expect(voidPaymentsCheck([1_500, 1_500], 3_000)).toBe('CLEAR');
      expect(voidPaymentsCheck([1_500, 1_501], 3_000)).toBe('PAID');
    });

    it('un abono sin base («sin tasa») decide antes que la suma, aunque el resto cupiera', () => {
      expect(voidPaymentsCheck([1_000, null], 3_000)).toBe('UNCONVERTED');
      expect(voidPaymentsCheck([null], 0)).toBe('UNCONVERTED');
      expect(voidPaymentsCheck([20_000_000, null], 0)).toBe('UNCONVERTED');
    });

    it('el mensaje de abonos sin convertir, en español', () => {
      expect(CANCELLATION_FEE_MESSAGES.voidUnconverted).toBe(
        'Hay abonos todavía sin convertir a la moneda del plan; registra la tasa del día o espera un minuto y vuelve a intentarlo',
      );
    });
  });
});
