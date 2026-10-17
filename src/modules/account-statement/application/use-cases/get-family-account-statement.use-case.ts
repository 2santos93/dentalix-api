import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  ACCOUNT_STATEMENT_REPOSITORY,
  type AccountStatementRepository,
} from '../../domain/ports/account-statement-repository.port';
import {
  STATEMENT_FAMILY_REPOSITORY,
  type StatementFamilyRepository,
} from '../../domain/ports/statement-family-repository.port';
import type {
  FamilyAccountStatement,
  FamilyCurrencyAmounts,
  FamilyStatementMember,
  StatementClinic,
} from '../../domain/entities/account-statement.entity';
import { computeAccountStatement } from '../compute-account-statement';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../../patients/application/assert-patient-in-clinic';
import {
  ACCOUNT_STATEMENT_CLOCK,
  type AccountStatementClock,
} from './get-account-statement.use-case';

// Montos Decimal(14,2): se suman en céntimos enteros (como el cálculo
// individual), así el total cuadra al céntimo con la suma de los subtotales.
const cents = (amount: number): number => Math.round(amount * 100);

const FIELDS = ['budgeted', 'paid', 'balance', 'overdueAmount'] as const;

function addInto(
  acc: Map<string, Record<(typeof FIELDS)[number], number>>,
  row: FamilyCurrencyAmounts,
): void {
  const current = acc.get(row.currency) ?? {
    budgeted: 0,
    paid: 0,
    balance: 0,
    overdueAmount: 0,
  };
  for (const f of FIELDS) current[f] += cents(row[f]);
  acc.set(row.currency, current);
}

/**
 * Estado de cuenta FAMILIAR del pagador (DX-203, solo lectura): el suyo y el
 * de cada paciente del que es pagador principal, con el subtotal por moneda
 * de cada uno y el total. Cada subtotal sale del MISMO cálculo que el estado
 * de cuenta individual (`computeAccountStatement` sobre la misma lectura del
 * repositorio), no de una suma aparte. Solo importes y nombres: ni planes, ni
 * movimientos, ni documentos de los otros miembros. No hay abono familiar.
 */
@Injectable()
export class GetFamilyAccountStatementUseCase {
  constructor(
    @Inject(ACCOUNT_STATEMENT_REPOSITORY)
    private readonly repo: AccountStatementRepository,
    @Inject(STATEMENT_FAMILY_REPOSITORY)
    private readonly family: StatementFamilyRepository,
    @Inject(ACCOUNT_STATEMENT_CLOCK)
    private readonly now: AccountStatementClock,
  ) {}

  async execute(payerPatientId: string): Promise<FamilyAccountStatement> {
    const family = await this.family.loadFamily(payerPatientId);
    if (!family) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    const issuedAt = this.now();
    const refs = [family.payer, ...family.dependents];

    let clinic: StatementClinic = { name: '', logoUrl: null };
    const members: FamilyStatementMember[] = [];
    const totals = new Map<string, Record<(typeof FIELDS)[number], number>>();
    for (const ref of refs) {
      const data = await this.repo.load(ref.id);
      // Retirado entre las dos lecturas: no cuenta.
      if (!data) continue;
      clinic = data.clinic;
      const { summary } = computeAccountStatement(data.snapshot, {
        today: issuedAt,
      });
      const rows = summary.map((s) => ({
        currency: s.currency,
        budgeted: s.budgeted,
        paid: s.paid,
        balance: s.balance,
        overdueAmount: s.overdueAmount,
      }));
      for (const row of rows) addInto(totals, row);
      members.push({
        patient: {
          id: ref.id,
          firstName: ref.firstName,
          lastName: ref.lastName,
        },
        relationship: ref.relationship,
        self: ref.id === family.payer.id,
        summary: rows,
      });
    }

    return {
      issuedAt,
      clinic,
      payer: {
        id: family.payer.id,
        firstName: family.payer.firstName,
        lastName: family.payer.lastName,
      },
      members,
      totals: [...totals.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, sum]) => ({
          currency,
          budgeted: sum.budgeted / 100,
          paid: sum.paid / 100,
          balance: sum.balance / 100,
          overdueAmount: sum.overdueAmount / 100,
        })),
    };
  }
}
