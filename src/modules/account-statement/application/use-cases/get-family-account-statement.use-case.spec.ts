import { NotFoundException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { GetFamilyAccountStatementUseCase } from './get-family-account-statement.use-case';
import { GetAccountStatementUseCase } from './get-account-statement.use-case';
import type {
  AccountStatementData,
  AccountStatementRepository,
} from '../../domain/ports/account-statement-repository.port';
import type { StatementFamilyRepository } from '../../domain/ports/statement-family-repository.port';
import type { StatementPaymentRow } from '../../domain/entities/account-statement.entity';

const NOW = new Date('2026-03-01T15:00:00.000Z');

function payment(
  id: string,
  planId: string,
  amount: number,
  currency = 'COP',
): StatementPaymentRow {
  return {
    id,
    treatmentPlanId: planId,
    amount,
    currency,
    paidAt: new Date('2026-02-10T17:00:00.000Z'),
    method: 'CASH',
    location: { id: 'l-1', name: 'Sede' },
    createdById: 'u-1',
    createdAt: new Date('2026-02-10T17:00:00.000Z'),
    timeZone: 'America/Bogota',
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
  };
}

function statement(
  id: string,
  firstName: string,
  plans: { id: string; billable: number; currency?: string }[],
  payments: StatementPaymentRow[],
): AccountStatementData {
  return {
    clinic: { name: 'Clínica Uno', logoUrl: null },
    patient: {
      id,
      firstName,
      lastName: 'Ortiz',
      docType: 'TI',
      docNumber: `doc-${id}`,
    },
    snapshot: {
      plans: plans.map((p) => ({
        id: p.id,
        status: 'ACCEPTED',
        currency: p.currency ?? 'COP',
        createdAt: new Date('2026-01-01'),
        billable: p.billable,
      })),
      payments,
      paymentPlans: [],
    },
  };
}

// DX-262: la madre solo trae un saldo migrado de su programa anterior.
const MOTHER = statement('mother', 'Claudia', [], []);
MOTHER.snapshot.openingBalances = [
  {
    id: 'ob-1',
    currency: 'COP',
    amount: 50000,
    asOfDate: '2025-11-30',
    asOfDateApproximate: false,
    concept: 'Saldo migrado',
    importBatchId: 'batch-1',
  },
];

const DATA: Record<string, AccountStatementData> = {
  mother: MOTHER,
  son: statement(
    'son',
    'Tomás',
    [{ id: 'tp-son', billable: 350000.35 }],
    [payment('p1', 'tp-son', 100000.1), payment('p2', 'tp-son', 0.15)],
  ),
  daughter: statement(
    'daughter',
    'Sofía',
    [
      { id: 'tp-dau', billable: 1200000.2 },
      { id: 'tp-eur', billable: 80.5, currency: 'EUR' },
    ],
    [
      payment('p3', 'tp-dau', 450000.05),
      // Un abono anulado no cuenta, igual que en el individual.
      { ...payment('p4', 'tp-dau', 9999), voidedAt: new Date('2026-02-11') },
      payment('p5', 'tp-eur', 20.25, 'EUR'),
    ],
  ),
};

function makeRepos() {
  const repo: AccountStatementRepository = {
    load: (id) => Promise.resolve(DATA[id] ?? null),
    loadBillablePlans: jest.fn(),
  };
  const family: StatementFamilyRepository = {
    loadNotice: () => Promise.resolve(null),
    loadFamily: (id) =>
      Promise.resolve(
        id === 'mother'
          ? {
              payer: {
                id: 'mother',
                firstName: 'Claudia',
                lastName: 'Ortiz',
                relationship: null,
              },
              dependents: [
                {
                  id: 'son',
                  firstName: 'Tomás',
                  lastName: 'Ortiz',
                  relationship: 'MOTHER',
                },
                {
                  id: 'daughter',
                  firstName: 'Sofía',
                  lastName: 'Ortiz',
                  relationship: 'MOTHER',
                },
              ],
            }
          : null,
      ),
  };
  return { repo, family };
}

describe('GetFamilyAccountStatementUseCase (DX-203)', () => {
  it('suma los saldos de sus pacientes con subtotal por paciente y cuadra al céntimo con los individuales', async () => {
    const { repo, family } = makeRepos();
    const uc = new GetFamilyAccountStatementUseCase(repo, family, () => NOW);
    const out = await uc.execute('mother');

    expect(out.payer).toEqual({
      id: 'mother',
      firstName: 'Claudia',
      lastName: 'Ortiz',
    });
    expect(out.members.map((m) => [m.patient.firstName, m.self])).toEqual([
      ['Claudia', true],
      ['Tomás', false],
      ['Sofía', false],
    ]);
    expect(out.members[1].summary).toEqual([
      {
        currency: 'COP',
        budgeted: 350000.35,
        openingBalance: 0,
        paid: 100000.25,
        balance: 250000.1,
        overdueAmount: 0,
      },
    ]);

    // La suma de los estados de cuenta individuales, uno a uno.
    const individual = new GetAccountStatementUseCase(repo, () => NOW, family);
    const actor = { userId: 'u-1', role: ClinicRole.ADMIN };
    const byCurrency = new Map<string, number>();
    for (const id of ['mother', 'son', 'daughter']) {
      for (const s of (await individual.execute(id, {}, actor)).summary) {
        byCurrency.set(
          s.currency,
          (byCurrency.get(s.currency) ?? 0) + Math.round(s.balance * 100),
        );
      }
    }
    expect(
      out.totals.map((t) => [t.currency, Math.round(t.balance * 100)]),
    ).toEqual([...byCurrency.entries()].sort());
    expect(out.totals).toEqual([
      {
        currency: 'COP',
        budgeted: 1550000.55,
        openingBalance: 50000,
        paid: 550000.3,
        balance: 1050000.25,
        overdueAmount: 0,
      },
      {
        currency: 'EUR',
        budgeted: 80.5,
        openingBalance: 0,
        paid: 20.25,
        balance: 60.25,
        overdueAmount: 0,
      },
    ]);
  });

  it('solo importes y nombres: nada de documentos, planes ni movimientos', async () => {
    const { repo, family } = makeRepos();
    const out = await new GetFamilyAccountStatementUseCase(
      repo,
      family,
      () => NOW,
    ).execute('mother');
    const json = JSON.stringify(out);
    expect(json).not.toContain('doc-');
    expect(json).not.toContain('tp-');
    expect(json).not.toContain('"movements"');
  });

  it('un pagador que no es de esta clínica: 404', async () => {
    const { repo, family } = makeRepos();
    await expect(
      new GetFamilyAccountStatementUseCase(repo, family, () => NOW).execute(
        'otra',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
