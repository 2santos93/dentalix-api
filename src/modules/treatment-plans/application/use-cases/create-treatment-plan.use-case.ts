import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { TREATMENT_PLAN_REPOSITORY } from '../../domain/ports/treatment-plan-repository.port';
import type { TreatmentPlanRepository } from '../../domain/ports/treatment-plan-repository.port';
import { CURRENCY_WHITELIST } from '../../domain/ports/currency-whitelist.port';
import type { CurrencyWhitelist } from '../../domain/ports/currency-whitelist.port';
import { TreatmentPlan } from '../../domain/entities/treatment-plan.entity';
import { PATIENT_REPOSITORY } from '../../../patients/domain/ports/patient-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import { assertPatientInClinic } from '../../../patients/application/assert-patient-in-clinic';
import { PLAN_CURRENCY_SOURCE } from '../../domain/ports/plan-currency-source.port';
import type { PlanCurrencySource } from '../../domain/ports/plan-currency-source.port';
import {
  locationCurrencyRequired,
  locationRequired,
} from '../../../../shared/locations/reference-location';

// NOTE: deliberately NO `tenantId`/`status` field — tenant comes from the
// guarded request context (the repository reads it, never this input), and a
// newly created plan always starts DRAFT (the schema default).
export interface CreateTreatmentPlanInput {
  patientId: string;
  currency?: string;
  notes?: string;
  createdById?: string;
}

@Injectable()
export class CreateTreatmentPlanUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
    @Inject(CURRENCY_WHITELIST)
    private readonly whitelist: CurrencyWhitelist,
    // Resuelve "¿este paciente es de ESTA clínica?" bajo RLS antes de insertar
    // (SEC-004): la FK a patients se chequea saltando la RLS, así que sin esto
    // se podía escribir contra un paciente de otra clínica.
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
    // R14: la moneda de un plan sin `currency` sale de la sede, nunca de USD.
    @Inject(PLAN_CURRENCY_SOURCE)
    private readonly planCurrency: PlanCurrencySource,
  ) {}

  async execute(input: CreateTreatmentPlanInput): Promise<TreatmentPlan> {
    // Sin `currency`: la de la sede activa o la común de la clínica (R14). Se
    // valida contra la tabla `currencies` en ambos casos, así que un cliente no
    // puede forzar un código desconocido ni por omisión ni con un valor erróneo.
    const currency = (
      input.currency ?? (await this.defaultCurrency())
    ).toUpperCase();
    if (!(await this.whitelist.has(currency))) {
      throw new BadRequestException(`Unknown currency: ${currency}`);
    }

    await assertPatientInClinic(this.patients, input.patientId);

    return this.repo.createPlan({
      patientId: input.patientId,
      currency,
      notes: input.notes,
      createdById: input.createdById,
    });
  }

  private async defaultCurrency(): Promise<string> {
    const ctx = await this.planCurrency.context();
    if (ctx.kind === 'location') {
      if (!ctx.currency) throw locationCurrencyRequired(ctx.locationId);
      return ctx.currency;
    }
    // Un solo valor posible y ninguna sede sin configurar: nunca se adivina.
    if (ctx.unconfigured) throw locationCurrencyRequired();
    if (ctx.currencies.length === 1) return ctx.currencies[0];
    if (ctx.currencies.length === 0) throw locationRequired();
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: 'PLAN_CURRENCY_REQUIRED',
      message:
        'Elige una sede o indica la moneda del plan: tus sedes usan monedas distintas.',
    });
  }
}
