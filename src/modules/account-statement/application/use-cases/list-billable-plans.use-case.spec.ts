import { NotFoundException } from '@nestjs/common';
import { ListBillablePlansUseCase } from './list-billable-plans.use-case';
import { AccountStatementRepository } from '../../domain/ports/account-statement-repository.port';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../../patients/application/assert-patient-in-clinic';

type BillableRows = Awaited<
  ReturnType<AccountStatementRepository['loadBillablePlans']>
>;

function repoWith(result: BillableRows) {
  const loadBillablePlans = jest.fn<Promise<BillableRows>, [string]>(() =>
    Promise.resolve(result),
  );
  const repo: AccountStatementRepository = {
    load: jest.fn(),
    loadBillablePlans,
  };
  return { repo, loadBillablePlans };
}

describe('ListBillablePlansUseCase', () => {
  it('devuelve los planes cobrables calculados del paciente', async () => {
    const { repo, loadBillablePlans } = repoWith([
      {
        id: 'tp-1',
        status: 'ACCEPTED',
        currency: 'USD',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        billable: 500,
        paidByCurrency: [{ currency: 'USD', amount: 200 }],
        hasActivePaymentPlan: true,
      },
      {
        id: 'tp-2',
        status: 'CANCELLED',
        currency: 'USD',
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
        billable: 100,
        paidByCurrency: [],
        hasActivePaymentPlan: false,
      },
    ]);
    const useCase = new ListBillablePlansUseCase(repo);

    const plans = await useCase.execute('p-1');

    expect(loadBillablePlans).toHaveBeenCalledWith('p-1');
    expect(plans).toEqual([
      {
        id: 'tp-1',
        status: 'ACCEPTED',
        currency: 'USD',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        total: 500,
        paid: 200,
        paidOtherCurrencies: [],
        balance: 300,
        hasActivePaymentPlan: true,
      },
    ]);
  });

  it('paciente inexistente, retirado o de otra clínica -> 404 con el mensaje de siempre', async () => {
    const useCase = new ListBillablePlansUseCase(repoWith(null).repo);
    await expect(useCase.execute('p-x')).rejects.toThrow(
      new NotFoundException(PATIENT_NOT_FOUND_MESSAGE),
    );
  });

  it('paciente sin planes cobrables -> lista vacía', async () => {
    const useCase = new ListBillablePlansUseCase(repoWith([]).repo);
    await expect(useCase.execute('p-1')).resolves.toEqual([]);
  });
});
