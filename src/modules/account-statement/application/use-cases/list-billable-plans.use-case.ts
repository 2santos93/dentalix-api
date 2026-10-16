import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ACCOUNT_STATEMENT_REPOSITORY } from '../../domain/ports/account-statement-repository.port';
import type { AccountStatementRepository } from '../../domain/ports/account-statement-repository.port';
import { BillablePlan } from '../../domain/entities/billable-plan.entity';
import { computeBillablePlans } from '../compute-billable-plans';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../../patients/application/assert-patient-in-clinic';

/**
 * Planes contra los que recepción puede registrar un abono o un plan de cuotas
 * (DX-067), sin datos clínicos. Un paciente inexistente, retirado o de otra
 * clínica da el mismo 404 que el estado de cuenta.
 */
@Injectable()
export class ListBillablePlansUseCase {
  constructor(
    @Inject(ACCOUNT_STATEMENT_REPOSITORY)
    private readonly repo: AccountStatementRepository,
  ) {}

  async execute(patientId: string): Promise<BillablePlan[]> {
    const rows = await this.repo.loadBillablePlans(patientId);
    if (!rows) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    return computeBillablePlans(rows);
  }
}
