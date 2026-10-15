import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GetAccountStatementUseCase } from './get-account-statement.use-case';
import {
  AccountStatementData,
  AccountStatementRepository,
} from '../../domain/ports/account-statement-repository.port';

const NOW = new Date('2026-03-01T15:00:00.000Z');

function data(): AccountStatementData {
  return {
    clinic: { name: 'Clínica Uno', logoUrl: null },
    patient: {
      id: 'p-1',
      firstName: 'Ana',
      lastName: 'Pérez',
      docType: 'CC',
      docNumber: '123',
    },
    snapshot: {
      plans: [
        {
          id: 'tp-1',
          status: 'ACCEPTED',
          currency: 'COP',
          createdAt: new Date('2026-01-01'),
          billable: 1000,
        },
      ],
      payments: [
        {
          id: 'pay-1',
          treatmentPlanId: 'tp-1',
          amount: 100,
          currency: 'COP',
          paidAt: new Date('2026-01-10T00:00:00.000Z'),
          method: 'CASH',
          location: { id: 'l-1', name: 'Sede' },
          voidedAt: null,
        },
        {
          id: 'pay-2',
          treatmentPlanId: 'tp-1',
          amount: 200,
          currency: 'COP',
          paidAt: new Date('2026-02-10T00:00:00.000Z'),
          method: 'CARD',
          location: { id: 'l-1', name: 'Sede' },
          voidedAt: null,
        },
      ],
      paymentPlans: [],
    },
  };
}

function makeUseCase(result: AccountStatementData | null = data()) {
  const load = jest.fn<Promise<AccountStatementData | null>, [string]>(() =>
    Promise.resolve(result),
  );
  const repo: AccountStatementRepository = { load };
  return { load, useCase: new GetAccountStatementUseCase(repo, () => NOW) };
}

describe('GetAccountStatementUseCase', () => {
  it('404s when the patient is not in this clinic', async () => {
    const { useCase } = makeUseCase(null);
    await expect(useCase.execute('p-x', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns header data, totals and every movement without a range', async () => {
    const { useCase, load } = makeUseCase();
    const out = await useCase.execute('p-1', {});

    expect(load).toHaveBeenCalledWith('p-1');
    expect(out.issuedAt).toEqual(NOW);
    expect(out.clinic.name).toBe('Clínica Uno');
    expect(out.patient).toMatchObject({ firstName: 'Ana', docNumber: '123' });
    expect(out.range).toEqual({ from: null, to: null });
    expect(out.summary[0]).toMatchObject({ budgeted: 1000, paid: 300 });
    expect(out.movements).toHaveLength(2);
  });

  it('filters only the movements by an inclusive civil-date range', async () => {
    const { useCase } = makeUseCase();
    const out = await useCase.execute('p-1', {
      from: '2026-02-01',
      to: '2026-02-10',
    });
    expect(out.range).toEqual({ from: '2026-02-01', to: '2026-02-10' });
    expect(out.movements.map((m) => m.id)).toEqual(['pay-2']);
    expect(out.summary[0]).toMatchObject({ paid: 300 });
  });

  it('accepts an open-ended range', async () => {
    const { useCase } = makeUseCase();
    const out = await useCase.execute('p-1', { to: '2026-01-31' });
    expect(out.movements.map((m) => m.id)).toEqual(['pay-1']);
  });

  it.each([
    [{ from: '2026-02-30' }],
    [{ to: '2026-13-01' }],
    [{ from: '2026-03-02', to: '2026-03-01' }],
  ])('rejects an invalid range %j', async (range) => {
    const { useCase, load } = makeUseCase();
    await expect(useCase.execute('p-1', range)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(load).not.toHaveBeenCalled();
  });
});
