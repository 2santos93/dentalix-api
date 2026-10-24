import {
  BadRequestException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import {
  ClinicRole,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
} from '@prisma/client';
import {
  ATTRIBUTION_ADMIN_ONLY_MESSAGE,
  ATTRIBUTION_ONLY_WHEN_DONE_MESSAGE,
  COMPLETED_AT_BY_SERVER_MESSAGE,
  COMPLETED_AT_FUTURE_MESSAGE,
  LOCATION_BY_REQUEST_MESSAGE,
  PERFORMER_REQUIRED_MESSAGE,
  REVERT_DONE_FORBIDDEN_MESSAGE,
  UNATTRIBUTED_CORRECTION_INCOMPLETE_MESSAGE,
  decideAttribution,
  isAttributionCorrection,
  type AttributionState,
} from './plan-item-attribution';

const { PROPOSED, ACCEPTED, DONE } = TreatmentPlanItemStatus;
const NOW = new Date('2026-10-23T15:00:00.000Z');
const YESTERDAY = new Date('2026-10-22T15:00:00.000Z');

const dentist = { userId: 'dentist-1', role: ClinicRole.DENTIST };
const admin = { userId: 'admin-1', role: ClinicRole.ADMIN };
const assistant = { userId: 'assistant-1', role: ClinicRole.ASSISTANT };

function item(overrides: Partial<AttributionState> = {}): AttributionState {
  return {
    status: ACCEPTED,
    performedById: null,
    performedLocationId: null,
    completedAt: null,
    ...overrides,
  };
}

const done = item({
  status: DONE,
  performedById: 'dentist-2',
  performedLocationId: 'sede-1',
  completedAt: YESTERDAY,
});

function thrown(fn: () => unknown): HttpException {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('no lanzó');
}

describe('decideAttribution (DX-050)', () => {
  describe('pasar a DONE', () => {
    it('sin performedById, un DENTIST queda como quien lo realizó; completedAt es la hora del servidor', () => {
      expect(decideAttribution(item(), { status: DONE }, dentist, NOW)).toEqual(
        { kind: 'SET', performedById: 'dentist-1', completedAt: NOW },
      );
    });

    it('sin performedById, un ADMIN (atiende) también queda como realizador', () => {
      expect(
        decideAttribution(
          item({ status: PROPOSED }),
          { status: DONE },
          admin,
          NOW,
        ),
      ).toEqual({ kind: 'SET', performedById: 'admin-1', completedAt: NOW });
    });

    it('con performedById, se usa el indicado aunque quien marca sea otro', () => {
      expect(
        decideAttribution(
          item(),
          { status: DONE, performedById: 'dentist-2' },
          assistant,
          NOW,
        ),
      ).toEqual({ kind: 'SET', performedById: 'dentist-2', completedAt: NOW });
    });

    it('una ASSISTANT sin performedById → 400 en español', () => {
      const error = thrown(() =>
        decideAttribution(item(), { status: DONE }, assistant, NOW),
      );
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toBe(PERFORMER_REQUIRED_MESSAGE);
    });

    it('completedAt en la petición → 400 (lo pone el servidor)', () => {
      const error = thrown(() =>
        decideAttribution(
          item(),
          { status: DONE, completedAt: YESTERDAY },
          admin,
          NOW,
        ),
      );
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toBe(COMPLETED_AT_BY_SERVER_MESSAGE);
    });
  });

  describe('ítem ya DONE (corrección)', () => {
    it('sin campos de atribución no cambia nada', () => {
      expect(decideAttribution(done, {}, dentist, NOW)).toBeUndefined();
      expect(
        decideAttribution(done, { status: DONE }, assistant, NOW),
      ).toBeUndefined();
    });

    it('repetir los mismos valores no es un cambio (lo puede cualquiera)', () => {
      expect(
        decideAttribution(
          done,
          {
            status: DONE,
            performedById: 'dentist-2',
            completedAt: new Date(YESTERDAY),
          },
          assistant,
          NOW,
        ),
      ).toBeUndefined();
    });

    it('un ADMIN cambia quién y cuándo', () => {
      const at = new Date('2026-10-21T10:00:00.000Z');
      expect(
        decideAttribution(
          done,
          { performedById: 'dentist-1', completedAt: at },
          admin,
          NOW,
        ),
      ).toEqual({
        kind: 'CORRECT',
        performedById: 'dentist-1',
        completedAt: at,
      });
    });

    it('un ADMIN cambia solo el profesional', () => {
      expect(
        decideAttribution(done, { performedById: 'dentist-1' }, admin, NOW),
      ).toEqual({ kind: 'CORRECT', performedById: 'dentist-1' });
    });

    it.each([dentist, assistant])(
      'un %o no puede cambiarlos → 403',
      (actor) => {
        const error = thrown(() =>
          decideAttribution(done, { performedById: actor.userId }, actor, NOW),
        );
        expect(error).toBeInstanceOf(ForbiddenException);
        expect(error.message).toBe(ATTRIBUTION_ADMIN_ONLY_MESSAGE);
      },
    );

    it('ni siquiera la fecha la cambia quien lo realizó', () => {
      const own = item({
        status: DONE,
        performedById: 'dentist-1',
        completedAt: YESTERDAY,
      });
      expect(() =>
        decideAttribution(own, { completedAt: NOW }, dentist, NOW),
      ).toThrow(ForbiddenException);
    });

    it('una fecha futura → 400', () => {
      const error = thrown(() =>
        decideAttribution(
          done,
          { completedAt: new Date(NOW.getTime() + 60_000) },
          admin,
          NOW,
        ),
      );
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toBe(COMPLETED_AT_FUTURE_MESSAGE);
    });

    it('un DONE anterior a DX-050 («Sin atribuir») lo atribuye un ADMIN con quién, cuándo y dónde (DX-305)', () => {
      expect(
        decideAttribution(
          item({ status: DONE }),
          {
            performedById: 'dentist-1',
            completedAt: YESTERDAY,
            performedLocationId: 'sede-2',
          },
          admin,
          NOW,
        ),
      ).toEqual({
        kind: 'CORRECT',
        performedById: 'dentist-1',
        completedAt: YESTERDAY,
        performedLocationId: 'sede-2',
      });
    });

    it.each([
      [{ performedById: 'dentist-1' }],
      [{ performedById: 'dentist-1', completedAt: YESTERDAY }],
      [{ performedById: 'dentist-1', performedLocationId: 'sede-2' }],
      [{ completedAt: YESTERDAY, performedLocationId: 'sede-2' }],
    ])('un «Sin atribuir» sin quién, cuándo o sede → 400 (%j)', (request) => {
      const error = thrown(() =>
        decideAttribution(item({ status: DONE }), request, admin, NOW),
      );
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toBe(UNATTRIBUTED_CORRECTION_INCOMPLETE_MESSAGE);
    });

    it('un ADMIN corrige solo la sede de uno atribuido; otro rol no (403)', () => {
      expect(
        decideAttribution(done, { performedLocationId: 'sede-2' }, admin, NOW),
      ).toEqual({ kind: 'CORRECT', performedLocationId: 'sede-2' });
      expect(
        decideAttribution(
          done,
          { performedLocationId: 'sede-1' },
          dentist,
          NOW,
        ),
      ).toBeUndefined();
      const error = thrown(() =>
        decideAttribution(
          done,
          { performedLocationId: 'sede-2' },
          { userId: 'dentist-2', role: ClinicRole.DENTIST },
          NOW,
        ),
      );
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.message).toBe(ATTRIBUTION_ADMIN_ONLY_MESSAGE);
    });

    it('al pasar a DONE la sede no llega en la petición → 400', () => {
      const error = thrown(() =>
        decideAttribution(
          item(),
          { status: DONE, performedLocationId: 'sede-2' },
          admin,
          NOW,
        ),
      );
      expect(error.message).toBe(LOCATION_BY_REQUEST_MESSAGE);
    });
  });

  describe('salir de DONE', () => {
    it('un ADMIN lo devuelve a aceptado: se limpia la atribución', () => {
      expect(decideAttribution(done, { status: ACCEPTED }, admin, NOW)).toEqual(
        { kind: 'CLEAR' },
      );
    });

    it('quien lo realizó también puede deshacerlo (marcado por error)', () => {
      const own = item({
        status: DONE,
        performedById: 'dentist-1',
        completedAt: YESTERDAY,
      });
      expect(
        decideAttribution(own, { status: ACCEPTED }, dentist, NOW),
      ).toEqual({ kind: 'CLEAR' });
    });

    it.each([dentist, assistant])(
      'otro (%o) no puede: 403, la producción es de quien la hizo',
      (actor) => {
        const error = thrown(() =>
          decideAttribution(done, { status: PROPOSED }, actor, NOW),
        );
        expect(error).toBeInstanceOf(ForbiddenException);
        expect(error.message).toBe(REVERT_DONE_FORBIDDEN_MESSAGE);
      },
    );

    it('con performedById o completedAt → 400', () => {
      expect(() =>
        decideAttribution(
          done,
          { status: ACCEPTED, performedById: 'dentist-2' },
          admin,
          NOW,
        ),
      ).toThrow(ATTRIBUTION_ONLY_WHEN_DONE_MESSAGE);
    });
  });

  describe('fuera de DONE', () => {
    it('sin campos de atribución, nada', () => {
      expect(
        decideAttribution(item(), { status: PROPOSED }, assistant, NOW),
      ).toBeUndefined();
      expect(decideAttribution(item(), {}, assistant, NOW)).toBeUndefined();
    });

    it.each([
      { performedById: 'dentist-1' },
      { completedAt: YESTERDAY },
      { status: ACCEPTED, performedById: 'dentist-1' },
    ])('con %o → 400', (request) => {
      const error = thrown(() =>
        decideAttribution(item(), request, admin, NOW),
      );
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toBe(ATTRIBUTION_ONLY_WHEN_DONE_MESSAGE);
    });
  });
});

describe('isAttributionCorrection (DX-050, plan cerrado)', () => {
  const {
    COMPLETED,
    CANCELLED,
    REJECTED,
    ACCEPTED: PLAN_ACCEPTED,
  } = TreatmentPlanStatus;

  it.each([COMPLETED, CANCELLED, REJECTED])(
    'en un plan %s, corregir quién o cuándo de un DONE se admite',
    (planStatus) => {
      expect(
        isAttributionCorrection(planStatus, DONE, {
          performedById: 'dentist-1',
        }),
      ).toBe(true);
      expect(
        isAttributionCorrection(planStatus, DONE, {
          status: DONE,
          completedAt: YESTERDAY,
        }),
      ).toBe(true);
    },
  );

  it('no si cambia algo más, si el ítem no es DONE o si no hay nada que corregir', () => {
    expect(
      isAttributionCorrection(COMPLETED, DONE, {
        performedById: 'dentist-1',
        notes: 'x',
      }),
    ).toBe(false);
    expect(
      isAttributionCorrection(COMPLETED, ACCEPTED, {
        performedById: 'dentist-1',
      }),
    ).toBe(false);
    expect(
      isAttributionCorrection(COMPLETED, DONE, {
        status: ACCEPTED,
        performedById: 'dentist-1',
      }),
    ).toBe(false);
    expect(isAttributionCorrection(COMPLETED, DONE, { status: DONE })).toBe(
      false,
    );
    expect(
      isAttributionCorrection(PLAN_ACCEPTED, DONE, {
        performedById: 'dentist-1',
      }),
    ).toBe(false);
  });
});
