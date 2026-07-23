import { JwtPayload } from '../crypto/token.service';

export interface TenantHostRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: JwtPayload;
  tenantHost?: { host?: string; tenantId: string | null };
}
