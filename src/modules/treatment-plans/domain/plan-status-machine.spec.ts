import { TreatmentPlanStatus } from '@prisma/client';
import {
  canTransition,
  PLAN_STATUS_LABELS,
  PLAN_STATUS_TRANSITIONS,
  planTransitionError,
} from './plan-status-machine';

const { DRAFT, PRESENTED, ACCEPTED, REJECTED, COMPLETED, CANCELLED } =
  TreatmentPlanStatus;
const ALL = Object.values(TreatmentPlanStatus);

// La tabla completa (DX-040): cada par origen → destino, a mano, para que un
// cambio en la máquina obligue a cambiar también este test.
const ALLOWED: ReadonlyArray<[TreatmentPlanStatus, TreatmentPlanStatus]> = [
  [DRAFT, PRESENTED],
  [DRAFT, ACCEPTED],
  [DRAFT, CANCELLED],
  [PRESENTED, ACCEPTED],
  [PRESENTED, REJECTED],
  [PRESENTED, CANCELLED],
  [ACCEPTED, COMPLETED],
  [ACCEPTED, CANCELLED],
  [REJECTED, CANCELLED],
];

const allPairs = ALL.flatMap((from) =>
  ALL.map((to) => [from, to] as [TreatmentPlanStatus, TreatmentPlanStatus]),
);
const isAllowed = (from: TreatmentPlanStatus, to: TreatmentPlanStatus) =>
  ALLOWED.some(([f, t]) => f === from && t === to);

describe('máquina de estados del plan de tratamiento (DX-040)', () => {
  it('cubre los seis estados del enum, con etiqueta en español', () => {
    expect(Object.keys(PLAN_STATUS_TRANSITIONS).sort()).toEqual(
      [...ALL].sort(),
    );
    expect(PLAN_STATUS_LABELS).toEqual({
      DRAFT: 'Borrador',
      PRESENTED: 'Presentado',
      ACCEPTED: 'Aceptado',
      REJECTED: 'Rechazado',
      COMPLETED: 'Completado',
      CANCELLED: 'Cancelado',
    });
  });

  it.each(allPairs.filter(([f, t]) => isAllowed(f, t)))(
    '%s → %s está permitida',
    (from, to) => {
      expect(canTransition(from, to)).toBe(true);
      expect(planTransitionError(from, to)).toBeNull();
    },
  );

  it.each(allPairs.filter(([f, t]) => !isAllowed(f, t)))(
    '%s → %s no está permitida',
    (from, to) => {
      expect(canTransition(from, to)).toBe(false);
      expect(planTransitionError(from, to)).toEqual(expect.any(String));
    },
  );

  it('quedarse en el mismo estado no es una transición', () => {
    for (const status of ALL) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('COMPLETED es final: ni siquiera se cancela', () => {
    expect(PLAN_STATUS_TRANSITIONS[COMPLETED]).toEqual([]);
    expect(PLAN_STATUS_TRANSITIONS[CANCELLED]).toEqual([]);
  });

  it('todo estado salvo COMPLETED (y el propio CANCELLED) se puede cancelar', () => {
    for (const status of ALL) {
      expect(canTransition(status, CANCELLED)).toBe(
        status !== COMPLETED && status !== CANCELLED,
      );
    }
  });

  it('el mensaje nombra los dos estados en español', () => {
    expect(planTransitionError(COMPLETED, PRESENTED)).toBe(
      'Un plan «Completado» no puede pasar a «Presentado».',
    );
    expect(planTransitionError(REJECTED, ACCEPTED)).toBe(
      'Un plan «Rechazado» no puede pasar a «Aceptado».',
    );
  });
});
