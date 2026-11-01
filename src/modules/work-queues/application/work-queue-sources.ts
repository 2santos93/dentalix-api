import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { ClosingQueueUseCases } from '../../closing-queue/application/closing-queue.use-cases';
import { ListInventoryItemsUseCase } from '../../inventory/application/use-cases/list-inventory-items.use-case';
import { CountAnamnesisInboxUseCase } from '../../medical-history-submissions/application/use-cases/anamnesis-review.use-cases';
import { GetReceivablesAgingUseCase } from '../../receivables/application/use-cases/get-receivables-aging.use-case';
import { PlanVisitsService } from '../../treatment-plans/application/plan-visits.service';
import { ListPendingFollowUpUseCase } from '../../treatment-plans/application/use-cases/list-pending-follow-up.use-case';
import { ListWaitlistUseCase } from '../../waitlist/application/use-cases/waitlist.use-cases';
import type { OverdueAmount } from '../domain/work-queues';
import type { WorkQueueSources } from './work-queues-summary.use-case';

/** Lo exigible ya vencido de una moneda: la deuda menos las cuotas que aún no vencen. */
export function overdueOf(buckets: {
  days0to30: number;
  days31to60: number;
  days61to90: number;
  over90: number;
}): number {
  return (
    Math.round(
      (buckets.days0to30 +
        buckets.days31to60 +
        buckets.days61to90 +
        buckets.over90) *
        100,
    ) / 100
  );
}

/**
 * Cada fuente llama al MISMO caso de uso que el `/count` de su lista, con los
 * mismos argumentos que su controlador cuando el cliente no manda filtros
 * (`page: 1, pageSize: 1` o `limit: 1` donde el recuento sale de la página).
 * Así el número es, por construcción, el de la lista (lo comprueba
 * `test/work-queues.e2e-spec.ts` contra cada endpoint).
 */
export function workQueueSources(deps: {
  closingQueue: ClosingQueueUseCases;
  anamnesis: CountAnamnesisInboxUseCase;
  followUp: ListPendingFollowUpUseCase;
  visits: PlanVisitsService;
  waitlist: ListWaitlistUseCase;
  receivables: GetReceivablesAgingUseCase;
  inventory: ListInventoryItemsUseCase;
  tenantContext: TenantContextService;
}): WorkQueueSources {
  const { tenantContext } = deps;
  return {
    // GET /closing-queue/count (ClosingQueueController.query + count).
    CLOSING_QUEUE: async (actor) => {
      const active = tenantContext.getLocationId();
      const r = await deps.closingQueue.count({
        actor: { userId: actor.userId, role: actor.role },
        allowedLocationIds: tenantContext.getAllowedLocationIds(),
        ...(active !== undefined ? { activeLocationId: active } : {}),
      });
      return { count: r.total };
    },
    // GET /medical-history/submissions/summary.
    ANAMNESIS_REVIEW: async () => ({
      count: (await deps.anamnesis.execute()).submitted,
    }),
    // GET /treatment-plans/pending-follow-up/count.
    QUOTE_FOLLOW_UP: async () => ({
      count: (await deps.followUp.execute({ page: 1, pageSize: 1 })).total,
    }),
    // GET /treatment-plans/unscheduled/count.
    ACCEPTED_UNSCHEDULED: async () => ({
      count: (await deps.visits.unscheduled({ limit: 1 })).total,
    }),
    // GET /waitlist (OPEN por defecto) → total.
    WAITLIST: async () => ({
      count: (await deps.waitlist.execute({ page: 1, pageSize: 1 })).total,
    }),
    // GET /receivables/aging/summary → totals. Las monedas no se suman: un
    // paciente puede deber en dos, así que el recuento es el mayor de cada
    // moneda (nunca una suma que lo cuente dos veces), y lo vencido va por
    // moneda.
    RECEIVABLES: async () => {
      const page = await deps.receivables.execute({
        locationId: tenantContext.getLocationId(),
        page: 1,
        pageSize: 1,
      });
      const overdue: OverdueAmount[] = page.totals
        .map((t) => ({ currency: t.currency, amount: overdueOf(t.buckets) }))
        .filter((t) => t.amount > 0);
      return {
        count: page.totals.reduce((max, t) => Math.max(max, t.patients), 0),
        overdue,
      };
    },
    // GET /inventory/items?lowStockOnly=true → total.
    LOW_STOCK: async () => ({
      count: (
        await deps.inventory.execute({
          page: 1,
          pageSize: 1,
          lowStockOnly: true,
        })
      ).total,
    }),
  };
}
