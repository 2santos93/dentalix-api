import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, concatMap } from 'rxjs';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { PlanAllocationRebalancer } from '../application/plan-allocation-rebalancer';

/** Lo que el interceptor lee de la petición (Express). */
export interface DrainRequest {
  method: string;
  params?: Record<string, string | undefined>;
  route?: { path?: string };
  user?: { sub?: string };
}

/** Planes que drena una petición; el resto lo hace el barrido (spec R9.2). */
export const DRAIN_PLANS_PER_REQUEST = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * El plan de la ruta, si lo hay: `:planId`, o `:id` en las rutas
 * `treatment-plans/:id…` (en `payments/:id` o `appointments/:id` el id no es
 * de un plan).
 */
function routePlanId(req: DrainRequest): string | undefined {
  const params = req.params ?? {};
  const id = /(^|\/)treatment-plans\/:id(\/|$)/.test(req.route?.path ?? '')
    ? params.id
    : undefined;
  const planId = params.planId ?? id;
  return planId && UUID.test(planId) ? planId : undefined;
}

/**
 * Reparto automático tras el COMMIT de cada escritura (DX-051, spec R9.2): al
 * terminar BIEN una petición que no es GET, drena la cola del tenant (el plan
 * de la ruta primero, como mucho 5 planes) y ESPERA antes de enviar la
 * respuesta, como `AuditInterceptor`, así quien lee justo después ya ve el
 * reparto. Se declara en el MISMO `@UseInterceptors` y DETRÁS de
 * `TenantContextInterceptor`: el tenant se captura al entrar y el drenado corre
 * con él. Un fallo nunca falla la petición: las solicitudes siguen en la cola y
 * las recoge el barrido.
 */
@Injectable()
export class DrainAllocationRebalancesInterceptor implements NestInterceptor {
  private readonly logger = new Logger('PaymentAllocations');

  constructor(
    private readonly rebalancer: PlanAllocationRebalancer,
    private readonly tenantContext: TenantContextService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<DrainRequest>();
    if (req.method === 'GET' || req.method === 'HEAD') return next.handle();
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      // Declarado fuera del contexto del tenant: lo recogerá el barrido.
      this.logger.warn({ event: 'payments.allocation_drain_without_tenant' });
      return next.handle();
    }
    const options = {
      actorId: req.user?.sub ?? null,
      preferPlanId: routePlanId(req),
      limit: DRAIN_PLANS_PER_REQUEST,
    };
    return next.handle().pipe(
      concatMap(async (body: unknown) => {
        try {
          await this.tenantContext.run(tenantId, () =>
            this.rebalancer.drainPending(options),
          );
        } catch (error) {
          this.logger.warn({
            event: 'payments.allocation_drain_failed',
            error: error instanceof Error ? error.name : typeof error,
          });
        }
        return body;
      }),
    );
  }
}
