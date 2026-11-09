import { EMPTY_CLINIC_FISCAL } from '../../../../../shared/clinic/clinic-fiscal';
import { TreatmentPlanStatus } from '@prisma/client';
import type { QuoteValidity } from '../../../domain/quote-validity';
import { NO_EXPIRED_ACCEPTANCE } from '../../../domain/expired-quote-acceptance';
import type {
  AcceptPlanOutcome,
  AcceptReprice,
  AcceptRepriced,
  NewPlanAcceptance,
  PlanQuoteRepository,
  PlanQuoteSource,
} from '../../../domain/ports/plan-quote-repository.port';
import type { RepricingSubject } from '../../../domain/ports/plan-repricing-repository.port';
import type { Repricing } from '../../repricing';

/** Presupuesto de ejemplo: un plan en borrador con dos ítems. */
export function quoteSource(
  overrides: Partial<PlanQuoteSource> = {},
): PlanQuoteSource {
  return {
    plan: {
      id: 'plan-1',
      patientId: 'patient-1',
      status: TreatmentPlanStatus.DRAFT,
      currency: 'USD',
      quoteIssuedOn: null,
      quoteValidUntil: null,
      presentedLocationId: null,
      quoteRegional: {
        locationId: 'loc-1',
        timeZone: 'America/Caracas',
        locale: 'es-VE',
        hourCycle: 'h12',
      },
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
    clinic: {
      name: 'Clínica Sonrisa',
      logoUrl: null,
      logoKey: null,
      fiscal: EMPTY_CLINIC_FISCAL,
      quoteValidityDays: 30,
    },
    location: {
      id: 'loc-1',
      name: 'Sede principal',
      address: 'Calle 1',
      timeZone: 'America/Caracas',
    },
    regional: {
      timeZone: 'America/Caracas',
      locale: 'es-VE',
      hourCycle: 'h12',
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

  /**
   * DX-379 (C): lo que la recotización ve del plan (el de Prisma lo lee con
   * el plan bloqueado). Sin él, `accept` con `reprice` falla.
   */
  subjectFor?: (source: PlanQuoteSource) => RepricingSubject;
  /** Las recotizaciones de la firma «escritas» (source ACCEPT). */
  readonly repricings: Repricing[] = [];

  /** Aplica al presupuesto los precios y la validez de la recotización. */
  private repriced(
    source: PlanQuoteSource,
    repricing: Repricing,
  ): PlanQuoteSource {
    const after = new Map(repricing.lines.map((l) => [l.itemId, l.after]));
    const validity = repricing.validityRenewed ? repricing.validity : null;
    return {
      ...source,
      plan: {
        ...source.plan,
        ...(validity
          ? {
              quoteIssuedOn: validity.issuedOn,
              quoteValidUntil: validity.validUntil,
            }
          : {}),
      },
      items: source.items.map((item) => {
        const state = after.get(item.id);
        return state
          ? {
              ...item,
              price: state.price,
              discount: state.discount,
              basePrice: state.basePrice,
              referencePrice: state.catalogPrice,
              agreementName: state.agreementName,
              listPriceCurrency: state.catalogCurrency,
            }
          : item;
      }),
    };
  }

  accept(
    patientId: string,
    planId: string,
    decide: (
      source: PlanQuoteSource,
      repriced: AcceptRepriced | null,
    ) => NewPlanAcceptance,
    reprice?: AcceptReprice,
  ): Promise<AcceptPlanOutcome> {
    const found = this.find(patientId, planId);
    if (!found) return Promise.resolve({ kind: 'NOT_FOUND' });
    // Como una transacción: nada cambia si algo lanza.
    let source = found;
    let repriced: AcceptRepriced | null = null;
    let repricing: Repricing | null = null;
    let row: NewPlanAcceptance;
    try {
      if (reprice) {
        if (!this.subjectFor) throw new Error('subjectFor sin configurar');
        repricing = reprice.decide(found, this.subjectFor(found));
        source = this.repriced(found, repricing);
        repriced = {
          repricingId: `repricing-${this.repricings.length + 1}`,
          before: found,
        };
      }
      row = decide(source, repriced);
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error('decide'),
      );
    }
    if (source.acceptance) return Promise.resolve({ kind: 'ALREADY_ACCEPTED' });
    if (repricing) this.repricings.push(repricing);
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
        // Como el de Prisma: el logo del instante de la firma.
        clinicLogoUrl: source.clinic.logoUrl,
        expiry: row.expiry ?? {
          ...NO_EXPIRED_ACCEPTANCE,
          quoteValidUntil: source.plan.quoteValidUntil,
        },
      },
    };
    this.sources.set(planId, accepted);
    return Promise.resolve({ kind: 'ACCEPTED', source: accepted });
  }

  /** Como el de Prisma: recotiza, relee y no deja nada escrito. */
  previewRepriced(
    patientId: string,
    planId: string,
    reprice: AcceptReprice,
  ): Promise<{ source: PlanQuoteSource; repricing: Repricing } | null> {
    const found = this.find(patientId, planId);
    if (!found) return Promise.resolve(null);
    try {
      if (!this.subjectFor) throw new Error('subjectFor sin configurar');
      const repricing = reprice.decide(found, this.subjectFor(found));
      return Promise.resolve({
        source: this.repriced(found, repricing),
        repricing,
      });
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error('decide'),
      );
    }
  }

  /** Como el de Prisma: solo escribe si el plan aún no tiene fechas. */
  issue(
    patientId: string,
    planId: string,
    decide: (source: PlanQuoteSource) => QuoteValidity | null,
  ): Promise<PlanQuoteSource | null> {
    const source = this.find(patientId, planId);
    if (!source) return Promise.resolve(null);
    const validity = decide(source);
    if (!validity || source.plan.quoteIssuedOn !== null) {
      return Promise.resolve(source);
    }
    const issued: PlanQuoteSource = {
      ...source,
      plan: {
        ...source.plan,
        quoteIssuedOn: validity.issuedOn,
        quoteValidUntil: validity.validUntil,
      },
    };
    this.sources.set(planId, issued);
    return Promise.resolve(issued);
  }
}
