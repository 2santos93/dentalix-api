/** Lo que responde la sonda de liveness del worker (`GET /health`). */
export interface LivenessReport {
  alive: boolean;
  /** El worker recibió el apagado: la sonda no lo da por muerto. */
  stopping: boolean;
  /** Fin de la última vuelta del bucle (o el arranque, si aún no hubo). */
  lastLoopAt: Date | null;
  /** Ms desde `lastLoopAt`. */
  ageMs: number | null;
  /** Umbral: 3 × JOBS_POLL_INTERVAL_MS + statement_timeout. */
  staleAfterMs: number;
}

/** Vueltas sin terminar tras las que el bucle se da por bloqueado. */
export const LIVENESS_MISSED_LOOPS = 3;

/**
 * Liveness del bucle del worker (DX-220, OPS-029). El bucle apunta el final
 * de cada vuelta (`loopFinished`), le haya ido bien o no a la BD: una BD
 * caída no se arregla reiniciando el worker (eso lo cuenta `stats`: sin
 * latido en job_workers). Lo que detecta es un bucle BLOQUEADO (una consulta
 * que nunca vuelve, un await colgado): si la última vuelta terminó hace más
 * de 3 × JOBS_POLL_INTERVAL_MS + el `statement_timeout` de la conexión (lo
 * más que puede tardar una sentencia legítima), la sonda da 503 y el
 * orquestador lo reinicia.
 */
export class WorkerLiveness {
  private startedAt: number | null = null;
  private lastLoopAt: number | null = null;
  private statementTimeoutMs = 0;
  private stopping = false;

  constructor(
    private readonly pollIntervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  started(): void {
    this.startedAt = this.now();
  }

  stopped(): void {
    this.stopping = true;
  }

  loopFinished(): void {
    this.lastLoopAt = this.now();
  }

  /** `statement_timeout` de la conexión de la app (0 = sin tope). */
  setStatementTimeoutMs(ms: number): void {
    this.statementTimeoutMs = Math.max(0, ms);
  }

  get staleAfterMs(): number {
    return (
      LIVENESS_MISSED_LOOPS * this.pollIntervalMs + this.statementTimeoutMs
    );
  }

  report(): LivenessReport {
    const reference = this.lastLoopAt ?? this.startedAt;
    const ageMs = reference === null ? null : this.now() - reference;
    return {
      // Sin arrancar no hay bucle que vigilar: no está vivo.
      alive: this.stopping || (ageMs !== null && ageMs <= this.staleAfterMs),
      stopping: this.stopping,
      lastLoopAt: reference === null ? null : new Date(reference),
      ageMs,
      staleAfterMs: this.staleAfterMs,
    };
  }
}
