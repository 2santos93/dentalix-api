import type { ConfigAuditSpec } from '../../../audit/domain/config-audit';

/** Ventana de corrección tras una subida del plazo (DX-330, R13). */
export const CORRECTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Código del evento de auditoría del cambio de plazo (DX-330, R11). */
export const RETENTION_SETTINGS_AUDIT_REASON =
  'CLINICAL_RECORD_RETENTION_SETTINGS';

/** Lo que `tenants` guarda del plazo y de su ventana de corrección. */
export interface StoredRetentionTerm {
  years: number;
  raisedAt: Date | null;
  yearsBeforeRaise: number | null;
}

export type RetentionTermPlan =
  | { kind: 'UNCHANGED' }
  | {
      kind: 'CHANGE';
      direction: 'UP' | 'DOWN';
      effectiveBefore: number;
      effectiveAfter: number;
      /** Plazo con el que una reducción calcula los suelos (R6, R13). */
      referenceYears: number;
      withinCorrectionWindow: boolean;
      nextWindow: { raisedAt: Date | null; yearsBeforeRaise: number | null };
    };

/** El plazo que rige: el guardado, nunca por debajo del mínimo de plataforma. */
export function effectiveRetentionYears(
  clinicYears: number,
  platformMinYears: number,
): number {
  return Math.max(clinicYears, platformMinYears);
}

/**
 * La ventana está abierta mientras `now < raisedAt + 24 h`, en milisegundos:
 * en el instante exacto de las 24 h ya está cerrada. Puro: `now` lo inyecta
 * quien llama.
 */
export function openCorrectionWindow(
  stored: StoredRetentionTerm,
  now: Date,
): { previousYears: number; until: Date } | null {
  if (stored.raisedAt === null || stored.yearsBeforeRaise === null) return null;
  const until = new Date(stored.raisedAt.getTime() + CORRECTION_WINDOW_MS);
  // `!(<)` y no `>=`: con una fecha inválida (NaN) la ventana queda cerrada.
  if (!(now.getTime() < until.getTime())) return null;
  return { previousYears: stored.yearsBeforeRaise, until };
}

/**
 * Qué hace guardar `requestedYears` (R5, R13). «Sin cambio» se decide por lo
 * guardado; la dirección, por el plazo vigente. Una subida abre la ventana
 * (sin moverla si ya hay una abierta); una bajada la cierra o la deja como
 * está, y calcula los suelos con el plazo de referencia.
 */
export function planRetentionTermChange(
  stored: StoredRetentionTerm,
  requestedYears: number,
  platformMinYears: number,
  now: Date,
): RetentionTermPlan {
  if (stored.years === requestedYears) return { kind: 'UNCHANGED' };

  const effectiveBefore = effectiveRetentionYears(
    stored.years,
    platformMinYears,
  );
  const effectiveAfter = effectiveRetentionYears(
    requestedYears,
    platformMinYears,
  );
  const open = openCorrectionWindow(stored, now);
  const kept = {
    raisedAt: stored.raisedAt,
    yearsBeforeRaise: stored.yearsBeforeRaise,
  };

  if (effectiveAfter >= effectiveBefore) {
    // Subida, o solo cambia lo guardado: una ventana abierta no se mueve y
    // una nueva solo se abre si el plazo vigente sube de verdad.
    const nextWindow =
      !open && effectiveAfter > effectiveBefore
        ? { raisedAt: now, yearsBeforeRaise: effectiveBefore }
        : kept;
    return {
      kind: 'CHANGE',
      direction: 'UP',
      effectiveBefore,
      effectiveAfter,
      referenceYears: effectiveBefore,
      withinCorrectionWindow: false,
      nextWindow,
    };
  }

  const closed = { raisedAt: null, yearsBeforeRaise: null };
  if (!open) {
    return {
      kind: 'CHANGE',
      direction: 'DOWN',
      effectiveBefore,
      effectiveAfter,
      referenceYears: effectiveBefore,
      withinCorrectionWindow: false,
      nextWindow: closed,
    };
  }
  return {
    kind: 'CHANGE',
    direction: 'DOWN',
    effectiveBefore,
    effectiveAfter,
    referenceYears: Math.max(effectiveAfter, open.previousYears),
    withinCorrectionWindow: true,
    nextWindow: effectiveAfter <= open.previousYears ? closed : kept,
  };
}

/** Evento de auditoría del cambio: valores guardados y `retentionTermChange` (R11). */
export function retentionTermAuditSpec(
  tenantId: string,
  storedYears: number,
  requestedYears: number,
  plan: Extract<RetentionTermPlan, { kind: 'CHANGE' }>,
  protectedPatients: number,
): ConfigAuditSpec {
  return {
    action: 'UPDATE',
    resourceType: 'CLINIC_SETTINGS',
    resourceId: tenantId,
    reason: RETENTION_SETTINGS_AUDIT_REASON,
    before: { clinicalRecordRetentionYears: storedYears },
    after: { clinicalRecordRetentionYears: requestedYears },
    extra: {
      retentionTermChange: {
        direction: plan.direction,
        protectedPatients: plan.direction === 'UP' ? 0 : protectedPatients,
        effectiveBefore: plan.effectiveBefore,
        effectiveAfter: plan.effectiveAfter,
        withinCorrectionWindow: plan.withinCorrectionWindow,
      },
    },
  };
}
