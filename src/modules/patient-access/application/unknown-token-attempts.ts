import { Injectable } from '@nestjs/common';
import {
  PATIENT_ACCESS_LOCK_MINUTES,
  decideVerification,
  type AttemptState,
  type VerifyDecision,
} from '../domain/patient-access';

/** Tope de tokens recordados: un ataque con millones de tokens no llena la memoria. */
const MAX_ENTRIES = 10_000;

/**
 * DX-101: espejo del contador de intentos para los tokens que NO casan con un
 * enlace vivo de la clínica (inventados, de otra clínica, caducados o
 * revocados). Siguen la MISMA regla que un enlace real (`decideVerification`
 * siempre con fecha errónea): 4 respuestas «Datos incorrectos» y al quinto
 * intento 429 durante 30 minutos. Así el 429 no revela si el token existe.
 *
 * En memoria (por réplica), por hash del token y acotado: con varias réplicas
 * cada una lleva su cuenta (riesgo aceptado, ver PROGRESS de DX-101); el
 * límite por IP y por token de la ruta sigue valiendo para todas.
 */
@Injectable()
export class UnknownTokenAttempts {
  private readonly entries = new Map<string, AttemptState>();

  /** Registra un intento fallido y dice qué responder. */
  fail(tokenKey: string, now: Date): VerifyDecision {
    const state = this.entries.get(tokenKey) ?? {
      failedAttempts: 0,
      lockedUntil: null,
    };
    const decision = decideVerification(state, false, now);
    switch (decision.kind) {
      case 'WRONG':
        this.remember(tokenKey, {
          failedAttempts: decision.failedAttempts,
          lockedUntil: null,
        });
        break;
      case 'LOCK':
        this.remember(tokenKey, {
          failedAttempts: decision.failedAttempts,
          lockedUntil: decision.lockedUntil,
        });
        break;
      default:
        break;
    }
    this.sweep(now);
    return decision;
  }

  private remember(key: string, state: AttemptState): void {
    // Reinsertar mueve la clave al final: se expulsa la menos reciente.
    this.entries.delete(key);
    this.entries.set(key, state);
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Quita algunas entradas cuyo bloqueo ya venció hace más de un bloqueo. */
  private sweep(now: Date): void {
    let checked = 0;
    for (const [key, state] of this.entries) {
      if (++checked > 50) break;
      const stale =
        state.lockedUntil !== null &&
        state.lockedUntil.getTime() + PATIENT_ACCESS_LOCK_MINUTES * 60_000 <
          now.getTime();
      if (stale) this.entries.delete(key);
    }
  }

  /** Solo tests. */
  size(): number {
    return this.entries.size;
  }
}
