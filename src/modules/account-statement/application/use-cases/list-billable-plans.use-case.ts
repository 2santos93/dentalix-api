import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ACCOUNT_STATEMENT_REPOSITORY } from '../../domain/ports/account-statement-repository.port';
import type { AccountStatementRepository } from '../../domain/ports/account-statement-repository.port';
import { BillablePlan } from '../../domain/entities/billable-plan.entity';
import { computeBillablePlans } from '../compute-billable-plans';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../../patients/application/assert-patient-in-clinic';
import { GetPlanBalanceUseCase } from '../../../payments/application/use-cases/get-plan-balance.use-case';

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
    private readonly getPlanBalance: GetPlanBalanceUseCase,
  ) {}

  async execute(patientId: string): Promise<BillablePlan[]> {
    const rows = await this.repo.loadBillablePlans(patientId);
    if (!rows) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    // DX-472-bis: el saldo de cada plan es el de `/balance`, con UN plazo
    // para todos (un proveedor colgado no retiene el selector de cobro).
    const planBalances = await this.getPlanBalance.computeMany(
      rows.flatMap((row) => (row.balanceInput ? [row.balanceInput] : [])),
    );
    return computeBillablePlans(rows, planBalances);
  }
}
