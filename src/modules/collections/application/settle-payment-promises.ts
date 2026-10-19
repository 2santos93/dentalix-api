import { Inject, Injectable, Logger } from '@nestjs/common';
import { RecordAuditEventUseCase } from '../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  COLLECTIONS_REPOSITORY,
  type CollectionsRepository,
} from '../domain/ports/collections-repository.port';
import type { OpenPromise } from '../domain/collections.entity';
import {
  evaluatePromise,
  type PromisePayment,
  type PromiseStatus,
} from '../domain/payment-promise-rule';
import { COLLECTIONS_CLOCK, type CollectionsClock } from './collections-clock';

export const SETTLE_PROMISES_JOB = 'collections.settle-promises';
/**
 * Cada hora (minuto 7, un ejecutor por tick con N workers): la regla es
 * DIARIA (un compromiso se incumple el día siguiente al suyo), pero cada sede
 * tiene su zona y su medianoche; barrer cada hora la aplica dentro de la
 * primera hora del nuevo día de CADA sede. Es idempotente: un compromiso ya
 * cerrado no se vuelve a tocar.
 */
export const SETTLE_PROMISES_SCHEDULE = 'collections.settle-promises.hourly';
export const SETTLE_PROMISES_CRON = '7 * * * *';

export interface SettleResult {
  kept: number;
  broken: number;
}

/**
 * Cierre de los compromisos de pago (DX-150): KEPT al cubrirse con abonos,
 * BROKEN el día siguiente a su fecha en la zona de su sede (regla en
 * payment-promise-rule.ts). Lo usan el barrido programado (todas las clínicas,
 * sin usuario) y el registro de un abono (solo ese paciente, con el usuario
 * que lo registra). Cada cambio deja un `audit_event` UPDATE de
 * PAYMENT_PROMISE con el motivo, sin importes ni textos.
 */
@Injectable()
export class SettlePaymentPromises {
  private readonly logger = new Logger('Collections');

  constructor(
    @Inject(COLLECTIONS_REPOSITORY)
    private readonly repo: CollectionsRepository,
    private readonly audit: RecordAuditEventUseCase,
    @Inject(COLLECTIONS_CLOCK) private readonly now: CollectionsClock,
  ) {}

  /** Barrido de todas las clínicas; falla al final si alguna falló. */
  async run(): Promise<SettleResult> {
    const total: SettleResult = { kept: 0, broken: 0 };
    let failed = 0;
    for (const tenantId of await this.repo.tenantIds()) {
      try {
        const r = await this.settleTenant(tenantId, undefined, null);
        total.kept += r.kept;
        total.broken += r.broken;
      } catch (error) {
        // Una clínica rota no deja sin cierre a las demás; la cola reintenta
        // el trabajo entero (es idempotente).
        failed += 1;
        this.logger.warn({
          event: 'collections.settle_failed',
          tenantId,
          error: error instanceof Error ? error.name : 'Error',
        });
      }
    }
    this.logger.log({ event: 'collections.settled', ...total, failed });
    if (failed > 0) {
      throw new Error(`Cerrar compromisos falló en ${failed} clínica(s)`);
    }
    return total;
  }

  /**
   * Tras registrar un abono: cierra el compromiso abierto del paciente si ya
   * se cumplió. Nunca lanza (el abono ya está confirmado); un fallo queda en el
   * log y lo recoge el barrido siguiente.
   */
  async afterPayment(
    patientId: string,
    context: AuditRequestContext,
  ): Promise<void> {
    try {
      await this.settleTenant(context.tenantId, patientId, context);
    } catch (error) {
      this.logger.warn({
        event: 'collections.settle_after_payment_failed',
        tenantId: context.tenantId,
        error: error instanceof Error ? error.name : 'Error',
      });
    }
  }

  private async settleTenant(
    tenantId: string,
    patientId: string | undefined,
    context: AuditRequestContext | null,
  ): Promise<SettleResult> {
    const result: SettleResult = { kept: 0, broken: 0 };
    const open = await this.repo.openPromises(tenantId, patientId);
    if (open.length === 0) return result;
    const since = new Date(Math.min(...open.map((p) => p.createdAt.getTime())));
    const payments = await this.repo.paymentsSince(
      tenantId,
      open.map((p) => p.patientId),
      since,
    );
    const byPatient = new Map<string, typeof payments>();
    for (const p of payments) {
      const list = byPatient.get(p.patientId) ?? [];
      list.push(p);
      byPatient.set(p.patientId, list);
    }
    const now = this.now();
    const decide = (
      terms: OpenPromise,
      paid: readonly PromisePayment[],
    ): PromiseStatus =>
      evaluatePromise(terms, paid, { now, timeZone: terms.timeZone }).status;
    for (const promise of open) {
      // Primera pasada con una foto de toda la clínica (sin N+1): solo los
      // que parece que cambian van a cerrarse.
      if (decide(promise, byPatient.get(promise.patientId) ?? []) === 'OPEN') {
        continue;
      }
      // El cierre vuelve a decidir con el candado del paciente y una foto
      // nueva (DX-215: un abono anulado entretanto ya no cuenta), y solo si
      // sigue abierto: dos barridos, un barrido y un abono, o un barrido y una
      // anulación a la vez no lo cierran dos veces ni lo auditan dos veces.
      const status = await this.repo.closePromise(tenantId, promise.id, decide);
      if (!status) continue;
      if (status === 'KEPT') result.kept += 1;
      else result.broken += 1;
      await this.audit.record({
        tenantId,
        locationId: context?.locationId ?? null,
        actor: context
          ? {
              kind: 'user',
              userId: context.actor.userId,
              role: context.actor.role,
            }
          : { kind: 'system' },
        action: 'UPDATE',
        resourceType: 'PAYMENT_PROMISE',
        resourceId: promise.id,
        patient: { kind: 'patient', id: promise.patientId },
        requestId: context?.requestId ?? null,
        ip: context?.ip ?? null,
        userAgent: context?.userAgent ?? null,
        metadata: {
          reason: status === 'KEPT' ? 'PROMISE_KEPT' : 'PROMISE_BROKEN',
          ...(context ? {} : { origin: 'JOB' as const }),
        },
      });
    }
    return result;
  }
}
