import { Injectable } from '@nestjs/common';

/**
 * Estado del apagado ordenado (DX-083, OPS-004/OPS-022). Lo pone
 * `installGracefulShutdown` al recibir SIGTERM, ANTES de cerrar nada; la
 * readiness (`/health/ready`) responde 503 desde ese momento para que el
 * balanceador saque la instancia mientras las peticiones en vuelo terminan.
 */
@Injectable()
export class ShutdownState {
  private drainingSince: Date | null = null;

  startDraining(now: Date = new Date()): void {
    this.drainingSince ??= now;
  }

  get draining(): boolean {
    return this.drainingSince !== null;
  }
}
