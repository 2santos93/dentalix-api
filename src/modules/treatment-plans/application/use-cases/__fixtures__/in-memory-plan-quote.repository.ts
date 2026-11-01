import { TreatmentPlanStatus } from '@prisma/client';
import type {
  AcceptPlanOutcome,
  NewPlanAcceptance,
  PlanQuoteRepository,
  PlanQuoteSource,
} from '../../../domain/ports/plan-quote-repository.port';

/** Presupuesto de ejemplo: un plan en borrador con dos ítems. */
export function quoteSource(
  overrides: Partial<PlanQuoteSource> = {},
): PlanQuoteSource {
  return {
    plan: {
      id: 'plan-1',
      patientId: 'patient-1',
      status: TreatmentPlanStatus.DRAFT,
      currency: 'COP',
    },
    items: [
      {
        id: 'item-1',
        toothNumber: '36',
        surfaces: [],
        procedure: 'Implante',
        price: 3500000,
        discount: 350000,
        basePrice: null,
        referencePrice: null,
        agreementName: null,
        agreementPayerName: null,
        listPriceCurrency: null,
      },
      {
        id: 'item-2',
        toothNumber: '16',
        surfaces: ['OCCLUSAL'],
        procedure: 'Resina',
        price: 180000,
        discount: 0,
        basePrice: null,
        referencePrice: null,
        agreementName: null,
        agreementPayerName: null,
        listPriceCurrency: null,
      },
    ],
    patient: {
      firstName: 'Ana',
      lastName: 'Pérez',
      docType: 'NATIONAL_ID',
      docTypeLabel: null,
      docNumber: '123',
    },
    clinic: { name: 'Clínica Sonrisa', logoUrl: null },
    location: {
      id: 'loc-1',
      name: 'Sede principal',
      address: 'Calle 1',
      timeZone: 'America/Bogota',
    },
    professionalName: 'Dra. Gómez',
    acceptance: null,
    ...overrides,
  };
}

/**
 * Fake de `PlanQuoteRepository` con la misma semántica que el de Prisma:
 * `loadSource` solo encuentra el plan bajo SU paciente, y `accept` corre
 * `decide` antes de escribir (si lanza, no cambia nada), guarda la aceptación,
 * pasa el plan a ACCEPTED y rechaza una segunda aceptación.
 */
export class InMemoryPlanQuoteRepository implements PlanQuoteRepository {
  readonly sources = new Map<string, PlanQuoteSource>();
  readonly inserted: NewPlanAcceptance[] = [];
  acceptedByName = 'Dra. Gómez';

  add(source: PlanQuoteSource): void {
    this.sources.set(source.plan.id, source);
  }

  private find(patientId: string, planId: string): PlanQuoteSource | null {
    const source = this.sources.get(planId);
    return source && source.plan.patientId === patientId ? source : null;
  }

  loadSource(
    patientId: string,
    planId: string,
  ): Promise<PlanQuoteSource | null> {
    return Promise.resolve(this.find(patientId, planId));
  }

  accept(
    patientId: string,
    planId: string,
    decide: (source: PlanQuoteSource) => NewPlanAcceptance,
  ): Promise<AcceptPlanOutcome> {
    const source = this.find(patientId, planId);
    if (!source) return Promise.resolve({ kind: 'NOT_FOUND' });
    let row: NewPlanAcceptance;
    try {
      row = decide(source);
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error('decide'),
      );
    }
    if (source.acceptance) return Promise.resolve({ kind: 'ALREADY_ACCEPTED' });
    this.inserted.push(row);
    const accepted: PlanQuoteSource = {
      ...source,
      plan: { ...source.plan, status: TreatmentPlanStatus.ACCEPTED },
      acceptance: {
        content: JSON.parse(JSON.stringify(row.content)) as unknown,
        contentHash: row.contentHash,
        signerName: row.signerName,
        signature: row.signature,
        acceptedAt: row.acceptedAt,
        acceptedByName: this.acceptedByName,
        acceptanceHash: row.acceptanceHash,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        remote: null,
      },
    };
    this.sources.set(planId, accepted);
    return Promise.resolve({ kind: 'ACCEPTED', source: accepted });
  }
}
