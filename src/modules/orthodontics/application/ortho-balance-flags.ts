import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OrthoBalanceFlag } from '../domain/entities';
import {
  ORTHO_CLOCK,
  ORTHO_REPOSITORY,
  type OrthoClock,
  type OrthoRepository,
} from '../domain/ports/ortho-repository.port';

export const NO_ORTHO_BALANCE: OrthoBalanceFlag = {
  hasOverdue: false,
  overdueDays: null,
};

/**
 * DX-285: «Ortodoncia: saldo vencido» de un LOTE de pacientes (tarjetas de la
 * agenda y panel «En clínica»), en UNA consulta: sin N+1. Solo la marca y los
 * días, nunca el importe. Si la consulta falla, ninguna marca: la agenda no
 * cae por esto (el fallo queda en el log, sin datos del paciente).
 */
@Injectable()
export class OrthoBalanceFlags {
  private readonly logger = new Logger('Orthodontics');

  constructor(
    @Inject(ORTHO_REPOSITORY) private readonly repo: OrthoRepository,
    @Inject(ORTHO_CLOCK) private readonly now: OrthoClock,
  ) {}

  async forPatients(
    patientIds: readonly string[],
  ): Promise<Map<string, OrthoBalanceFlag>> {
    try {
      return await this.repo.overdueFlags(patientIds, this.now());
    } catch (error) {
      this.logger.warn({
        event: 'ortho.balance_flags_failed',
        error: error instanceof Error ? error.name : 'unknown',
      });
      return new Map();
    }
  }
}
