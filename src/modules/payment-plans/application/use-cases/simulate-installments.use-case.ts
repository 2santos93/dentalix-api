import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import {
  isPlanBillable,
  notBillableMessage,
} from '../../../treatment-plans/domain/plan-status-machine';
import {
  CURRENCY_DIGITS_CATALOG,
  type CurrencyDigitsCatalog,
} from '../../../../shared/money/currency-digits';
import {
  PAYMENT_PLAN_REPOSITORY,
  type PaymentPlanRepository,
} from '../../domain/ports/payment-plan-repository.port';
import {
  billableOnAcceptance,
  parseInstallmentTerms,
  planInstallmentSchedule,
  type InstallmentSchedule,
  type InstallmentTermsInput,
} from '../schedule/installment-schedule';
import {
  ACTIVE_PAYMENT_PLAN_MESSAGE,
  PLAN_CURRENCY_NOT_IN_CATALOG_MESSAGE,
} from './create-payment-plan.use-case';

/** DX-041: escenarios por simulación (los que caben en pantalla y en el PDF). */
export const MAX_SIMULATION_SCENARIOS = 3;

export interface InstallmentSimulation {
  treatmentPlanId: string;
  currency: string;
  /** El saldo que se financia: lo cobrable del plan una vez aceptado. */
  totalToFinance: number;
  scenarios: InstallmentSchedule[];
}

/**
 * DX-041: simula hasta 3 planes de cuotas del presupuesto SIN escribir nada.
 * Cada escenario sale de `planInstallmentSchedule`, la misma función que usa
 * el alta del plan de cuotas, sobre el saldo que se financiaría al aceptar
 * (`billableOnAcceptance`, la cuenta del saldo): cuotas y fechas son
 * exactamente las que se guardarían con los mismos datos.
 */
@Injectable()
export class SimulateInstallmentsUseCase {
  constructor(
    private readonly getTreatmentPlan: GetTreatmentPlanUseCase,
    @Inject(PAYMENT_PLAN_REPOSITORY)
    private readonly repo: PaymentPlanRepository,
    @Inject(CURRENCY_DIGITS_CATALOG)
    private readonly currencyDigits: CurrencyDigitsCatalog,
  ) {}

  async execute(
    treatmentPlanId: string,
    scenarios: readonly InstallmentTermsInput[],
  ): Promise<InstallmentSimulation> {
    if (scenarios.length < 1 || scenarios.length > MAX_SIMULATION_SCENARIOS) {
      throw new BadRequestException(
        `Simula entre 1 y ${MAX_SIMULATION_SCENARIOS} escenarios.`,
      );
    }
    const terms = scenarios.map(parseInstallmentTerms);

    // 404 si no existe, está retirado o es de otra clínica (RLS).
    const plan = await this.getTreatmentPlan.execute(treatmentPlanId);
    if (!isPlanBillable(plan.status)) {
      throw new ConflictException(notBillableMessage(plan.status));
    }
    // Aceptar con cuotas (o darlas de alta) chocaría con el plan activo.
    if (await this.repo.findActiveByPlan(treatmentPlanId)) {
      throw new ConflictException(ACTIVE_PAYMENT_PLAN_MESSAGE);
    }
    const digits = await this.currencyDigits.table([plan.currency]);
    if (!digits.has(plan.currency)) {
      throw new UnprocessableEntityException(
        PLAN_CURRENCY_NOT_IN_CATALOG_MESSAGE(plan.currency),
      );
    }
    const totalToFinance = billableOnAcceptance(plan.items);
    const roundingDigits = digits.roundingDigits(plan.currency);
    return {
      treatmentPlanId,
      currency: plan.currency,
      totalToFinance,
      scenarios: terms.map((t) =>
        planInstallmentSchedule(t, totalToFinance, roundingDigits),
      ),
    };
  }
}
