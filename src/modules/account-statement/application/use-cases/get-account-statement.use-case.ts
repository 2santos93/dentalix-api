import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ACCOUNT_STATEMENT_REPOSITORY } from '../../domain/ports/account-statement-repository.port';
import type { AccountStatementRepository } from '../../domain/ports/account-statement-repository.port';
import { AccountStatement } from '../../domain/entities/account-statement.entity';
import { computeAccountStatement } from '../compute-account-statement';
import { GetPlanBalanceUseCase } from '../../../payments/application/use-cases/get-plan-balance.use-case';
import type { VoidActor } from '../../../payments/domain/void-window';
import { parseCivilDate } from '../../../../shared/time/civil-day';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../../patients/application/assert-patient-in-clinic';
import {
  STATEMENT_FAMILY_REPOSITORY,
  type StatementFamilyRepository,
} from '../../domain/ports/statement-family-repository.port';
import { statementAddressee } from '../statement-addressee';
import { DocumentTypeNamesReader } from '../../../patients/domain/ports/document-type-names-repository.port';
import { documentTypeName } from '../../../patients/domain/document-type';
import {
  CURRENCY_DIGITS_CATALOG,
  roundingDigitsLookup,
  type CurrencyDigitsCatalog,
} from '../../../../shared/money/currency-digits';

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
    @Inject(STATEMENT_FAMILY_REPOSITORY)
    private readonly family: StatementFamilyRepository,
    private readonly documentTypeNames: DocumentTypeNamesReader,
    private readonly getPlanBalance: GetPlanBalanceUseCase,
    // B4 (DX-472-bis): decimales de cada moneda para los estados de cuota.
    @Optional()
    @Inject(CURRENCY_DIGITS_CATALOG)
    private readonly currencyDigits?: CurrencyDigitsCatalog,
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

    const [data, notice, names] = await Promise.all([
      this.repo.load(patientId),
      this.family.loadNotice(patientId),
      this.documentTypeNames.get(),
    ]);
    if (!data) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }

    const issuedAt = this.now();
    const planBalances = await this.getPlanBalance.computeMany(
      data.planBalances,
    );
    const roundingDigitsOf = await roundingDigitsLookup(
      this.currencyDigits,
      data.snapshot.paymentPlans.map((pp) => pp.currency),
    );
    const computed = computeAccountStatement(data.snapshot, {
      roundingDigitsOf,
      today: issuedAt,
      voidActor: actor,
      movementsFrom: from,
      movementsTo: to,
      planBalances,
    });

    return {
      issuedAt,
      clinic: data.clinic,
      // En vivo: el nombre visible de hoy (DX-327, R17 y R18).
      patient: {
        ...data.patient,
        docTypeName: documentTypeName(
          data.patient.docType,
          data.patient.docTypeLabel,
          names,
        ),
      },
      // DX-203: un menor o un paciente sin email, a nombre de su responsable.
      addressee: statementAddressee(data.patient, notice, issuedAt),
      range: { from: input.from ?? null, to: input.to ?? null },
      rateProviderTimedOut: computed.plans.some((p) => p.rateProviderTimedOut),
      ...computed,
    };
  }
}
