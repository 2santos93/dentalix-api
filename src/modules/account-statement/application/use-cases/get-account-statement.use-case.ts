import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ACCOUNT_STATEMENT_REPOSITORY } from '../../domain/ports/account-statement-repository.port';
import type { AccountStatementRepository } from '../../domain/ports/account-statement-repository.port';
import { AccountStatement } from '../../domain/entities/account-statement.entity';
import { computeAccountStatement } from '../compute-account-statement';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../../patients/application/assert-patient-in-clinic';

export interface GetAccountStatementInput {
  /** Primer día de los movimientos (YYYY-MM-DD), inclusive. */
  from?: string;
  /** Último día de los movimientos (YYYY-MM-DD), inclusive. */
  to?: string;
}

// Reloj inyectable: las specs fijan "hoy" (qué cuota está vencida y la fecha de
// emisión); producción usa el real. Mismo patrón que GetPaymentPlanUseCase.
export type AccountStatementClock = () => Date;
export const ACCOUNT_STATEMENT_CLOCK = Symbol('ACCOUNT_STATEMENT_CLOCK');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Día civil (YYYY-MM-DD) a medianoche UTC, validando que exista — mismo
 * criterio que la caja (ListCashPaymentsUseCase): `paidAt` es un día civil
 * guardado como medianoche UTC, y `new Date('2026-02-30')` no falla, se va al
 * 2 de marzo.
 */
function parseCivilDate(value: string, field: 'from' | 'to'): Date {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00.000Z`)
    : null;
  if (
    !date ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new BadRequestException(
      `${field} must be a valid calendar date (YYYY-MM-DD)`,
    );
  }
  return date;
}

@Injectable()
export class GetAccountStatementUseCase {
  constructor(
    @Inject(ACCOUNT_STATEMENT_REPOSITORY)
    private readonly repo: AccountStatementRepository,
    @Inject(ACCOUNT_STATEMENT_CLOCK)
    private readonly now: AccountStatementClock,
  ) {}

  async execute(
    patientId: string,
    input: GetAccountStatementInput,
  ): Promise<AccountStatement> {
    const from =
      input.from !== undefined ? parseCivilDate(input.from, 'from') : undefined;
    const to =
      input.to !== undefined ? parseCivilDate(input.to, 'to') : undefined;
    if (from && to && from.getTime() > to.getTime()) {
      throw new BadRequestException('from must be on or before to');
    }

    const data = await this.repo.load(patientId);
    if (!data) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }

    const issuedAt = this.now();
    const computed = computeAccountStatement(data.snapshot, {
      today: issuedAt,
      movementsFrom: from,
      movementsToExclusive: to ? new Date(to.getTime() + DAY_MS) : undefined,
    });

    return {
      issuedAt,
      clinic: data.clinic,
      patient: data.patient,
      range: { from: input.from ?? null, to: input.to ?? null },
      ...computed,
    };
  }
}
