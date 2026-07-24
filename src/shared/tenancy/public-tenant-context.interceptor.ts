import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { TenantContextService } from './tenant-context.service';
import { TenantHostRequest } from './tenant-host-request';

/**
 * Public-route counterpart to TenantContextInterceptor. Authenticated routes
 * MUST reject when the host doesn't resolve to a tenant (401, via
 * TenantContextInterceptor) — there's a JWT to cross-check and no legitimate
 * "no tenant" case. Public routes (e.g. GET /public/tenant/branding) have no
 * JWT and a legitimate "unknown/absent host" case that the caller needs to
 * turn into its own semantics (404, not 401) — so this interceptor never
 * throws. When the host resolves to a tenant it runs the handler inside that
 * tenant's ALS context (same run()-wraps-next.handle() pattern, for the same
 * reason: enterWith in a guard/interceptor does not survive the async
 * boundary into the handler). When it doesn't, it simply runs the handler
 * with no tenant context, so `TenantContextService.getTenantId()` returns
 * `undefined` and the use case decides what that means (here: 404).
 */
@Injectable()
export class PublicTenantContextInterceptor implements NestInterceptor {
  constructor(private readonly tenantContext: TenantContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<TenantHostRequest>();
    const hostTenantId = req.tenantHost?.tenantId;

    if (!hostTenantId) {
      return next.handle();
    }

    return new Observable((subscriber) => {
      this.tenantContext.run(hostTenantId, () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}
