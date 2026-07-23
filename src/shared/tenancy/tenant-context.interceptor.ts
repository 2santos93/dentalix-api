import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { TenantContextService } from './tenant-context.service';
import { TenantHostRequest } from './tenant-host-request';

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly tenantContext: TenantContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<TenantHostRequest>();
    // The host is the authority for the active tenant.
    const hostTenantId = req.tenantHost?.tenantId;
    if (!hostTenantId) {
      throw new UnauthorizedException('No tenant in context');
    }
    // A token issued for another tenant must not be usable on this host.
    if (req.user && req.user.tenantId !== hostTenantId) {
      throw new UnauthorizedException('Tenant mismatch');
    }
    // run() keeps the ALS store active through the handler's async execution,
    // because we subscribe to next.handle() INSIDE the run callback (enterWith
    // in a guard does not survive the guard->handler async boundary).
    return new Observable((subscriber) => {
      this.tenantContext.run(hostTenantId, () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}
