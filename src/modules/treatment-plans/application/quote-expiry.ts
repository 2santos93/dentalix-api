import { Inject, Injectable } from '@nestjs/common';
import type { TreatmentPlanStatus } from '@prisma/client';
import { isQuoteExpired, quoteCanExpire } from '../domain/quote-validity';
import {
  PLAN_QUOTE_ZONES,
  type PlanQuoteZones,
} from '../domain/ports/plan-quote-zones.port';
import { TREATMENT_PLAN_CLOCK, type PlanClock } from './plan-clock';

/** Lo que hace falta de un plan para saber si su presupuesto venció. */
export interface QuoteExpirySubject {
  status: TreatmentPlanStatus;
  quoteValidUntil: string | null;
  presentedLocationId: string | null;
}

/**
 * DX-379 (D-13): añade `quoteExpired` a los planes que devuelve la API. Lo
 * calcula el servidor con el día civil de la sede del plan (la de su
 * presentación o, sin presentar, la de escritura) para que la web y la API
 * nunca discrepen cerca de medianoche. Un plan sin validez guardada nunca
 * vence, y solo un borrador o un plan presentado puede verse vencido (I-1):
 * aceptado, completado, rechazado o cancelado, su validez ya no cuenta.
 *
 * Una sede sin zona válida no tumba la respuesta: su plan sale como no
 * vencido (el presupuesto en sí ya da el 409 de zona al abrirse).
 */
@Injectable()
export class QuoteExpiry {
  constructor(
    @Inject(PLAN_QUOTE_ZONES)
    private readonly zones: PlanQuoteZones,
    @Inject(TREATMENT_PLAN_CLOCK)
    private readonly now: PlanClock,
  ) {}

  async stamp<T extends QuoteExpirySubject>(
    plans: readonly T[],
  ): Promise<(T & { quoteExpired: boolean })[]> {
    const dated = plans.filter(
      (p) => p.quoteValidUntil !== null && quoteCanExpire(p.status),
    );
    if (dated.length === 0) {
      return plans.map((p) => ({ ...p, quoteExpired: false }));
    }
    const ids = [
      ...new Set(
        dated.flatMap((p) =>
          p.presentedLocationId ? [p.presentedLocationId] : [],
        ),
      ),
    ];
    const zoneOf = await this.zones.zonesFor(ids);
    const now = this.now();
    return plans.map((p) => {
      const zone =
        p.quoteValidUntil === null || !quoteCanExpire(p.status)
          ? null
          : zoneOf(p.presentedLocationId);
      return {
        ...p,
        quoteExpired:
          zone !== null && isQuoteExpired(p.quoteValidUntil, now, zone),
      };
    });
  }

  async one<T extends QuoteExpirySubject>(
    plan: T,
  ): Promise<T & { quoteExpired: boolean }> {
    const [stamped] = await this.stamp([plan]);
    return stamped;
  }
}
