import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SLOT_OFFER_REPOSITORY,
  type SlotOfferRepository,
} from '../domain/ports/slot-offer-repository.port';
import {
  OPENING_CLOCK,
  type OpeningClock,
} from './use-cases/opening-candidates.use-cases';

export const EXPIRE_SLOT_OFFERS_JOB = 'waitlist.expire-slot-offers';
/**
 * Cada 5 minutos, un ejecutor por tick: el enlace caduca al empezar el hueco
 * y el panel ya lo pinta «Caducado» al momento (lo calcula con `expiresAt`);
 * el barrido deja el resultado guardado y auditado aunque nadie lo abra.
 */
export const EXPIRE_SLOT_OFFERS_SCHEDULE =
  'waitlist.expire-slot-offers.every-five-minutes';
export const EXPIRE_SLOT_OFFERS_CRON = '*/5 * * * *';
/**
 * DX-476: ofertas por lote; cada lote es su propia transacción (unas 150
 * sentencias, muy por debajo del timeout de 5 s de DX-431) y el barrido sigue
 * lote a lote hasta no encontrar más vencidas.
 */
export const EXPIRE_BATCH_SIZE = 50;
/** Tope de lotes por clínica y pasada (10.000 ofertas); el resto, a la siguiente. */
export const EXPIRE_MAX_BATCHES = 200;

export interface ExpireSlotOffersResult {
  expired: number;
}

/**
 * DX-435: las ofertas con enlace PENDING cuyo `expiresAt` pasó sin que el
 * paciente las abriera pasan a EXPIRED, con su `audit_event` UPDATE de
 * WAITLIST_OFFER (origen PUBLIC_LINK, reason SLOT_OFFER_EXPIRED, sin actor).
 * Idempotente: una oferta ya resuelta no se vuelve a tocar.
 */
@Injectable()
export class ExpireSlotOffers {
  private readonly logger = new Logger('Waitlist');

  constructor(
    @Inject(SLOT_OFFER_REPOSITORY) private readonly repo: SlotOfferRepository,
    @Inject(OPENING_CLOCK) private readonly clock: OpeningClock,
  ) {}

  /** Todas las clínicas; falla al final si alguna falló (la cola reintenta). */
  async run(): Promise<ExpireSlotOffersResult> {
    const now = this.clock();
    let expired = 0;
    let failed = 0;
    for (const tenantId of await this.repo.tenantIds()) {
      try {
        expired += await this.expireTenant(tenantId, now);
      } catch (error) {
        failed += 1;
        this.logger.warn({
          event: 'waitlist.expire_slot_offers_failed',
          tenantId,
          error: error instanceof Error ? error.name : 'Error',
        });
      }
    }
    this.logger.log({ event: 'waitlist.slot_offers_expired', expired, failed });
    if (failed > 0) {
      throw new Error(`Caducar ofertas falló en ${failed} clínica(s)`);
    }
    return { expired };
  }

  /**
   * Una clínica: lotes pequeños, cada uno en su transacción y por id
   * ascendente (el orden de bloqueo de «Aceptar»). Un lote que falla no
   * deshace los anteriores, que ya están confirmados.
   */
  private async expireTenant(tenantId: string, now: Date): Promise<number> {
    let expired = 0;
    let afterId: string | null = null;
    for (let batch = 0; batch < EXPIRE_MAX_BATCHES; batch++) {
      const done = await this.repo.expireDueBatch(
        tenantId,
        now,
        EXPIRE_BATCH_SIZE,
        afterId,
      );
      expired += done.expired;
      if (done.scanned < EXPIRE_BATCH_SIZE || done.lastId === null) break;
      afterId = done.lastId;
    }
    return expired;
  }
}
