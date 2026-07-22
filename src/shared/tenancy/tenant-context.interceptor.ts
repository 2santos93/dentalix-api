import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { TenantContextService } from './tenant-context.service';
import { JwtPayload } from '../crypto/token.service';

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly tenantContext: TenantContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ user?: JwtPayload }>();
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException('No tenant in context');
    }
    // run() keeps the ALS store active through the handler's async execution,
    // because we subscribe to next.handle() INSIDE the run callback (enterWith
    // in a guard does not survive the guard->handler async boundary).
    return new Observable((subscriber) => {
      this.tenantContext.run(tenantId, () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}
