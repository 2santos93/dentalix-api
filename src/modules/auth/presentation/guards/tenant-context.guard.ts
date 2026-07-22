import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { JwtPayload } from '../../../../shared/crypto/token.service';

@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(private readonly tenantContext: TenantContextService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: JwtPayload }>();
    const tenantId = request.user?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException('No tenant in context');
    }
    // enterWith persiste el tenant en el contexto async actual → el handler y los
    // repos posteriores lo ven vía tenantContext.getTenantId().
    this.tenantContext.enterWith(tenantId);
    return true;
  }
}
