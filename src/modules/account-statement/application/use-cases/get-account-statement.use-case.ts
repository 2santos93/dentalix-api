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
import type { VoidActor } from '../../../payments/domain/void-window';
import { parseCivilDate } from '../../../../shared/time/civil-day';
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

/**
 * Día civil (YYYY-MM-DD) que exista — `new Date('2026-02-30')` no falla, se va
 * al 2 de marzo. Se compara con el día de cada abono EN LA ZONA DE SU SEDE
 * (DX-097), igual que la caja.
 */
function requireCivilDate(value: string, field: 'from' | 'to'): string {
  const day = parseCivilDate(value);
  if (day === null) {
    throw new BadRequestException(
      `${field} must be a valid calendar date (YYYY-MM-DD)`,
    );
  }
  return day;
}

@Injectable()
export class GetAccountStatementUseCase {
  constructor(
    @Inject(ACCOUNT_STATEMENT_REPOSITORY)
    private readonly repo: AccountStatementRepository,
    @Inject(ACCOUNT_STATEMENT_CLOCK)
    private readonly now: AccountStatementClock,
  ) {}

  /** `actor` (del token) solo decide el `canVoid` de cada movimiento. */
  async execute(
    patientId: string,
    input: GetAccountStatementInput,
    actor: VoidActor,
  ): Promise<AccountStatement> {
    const from =
      input.from !== undefined
        ? requireCivilDate(input.from, 'from')
        : undefined;
    const to =
      input.to !== undefined ? requireCivilDate(input.to, 'to') : undefined;
    if (from && to && from > to) {
      throw new BadRequestException('from must be on or before to');
    }

    const data = await this.repo.load(patientId);
    if (!data) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }

    const issuedAt = this.now();
    const computed = computeAccountStatement(data.snapshot, {
      today: issuedAt,
      voidActor: actor,
      movementsFrom: from,
      movementsTo: to,
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
