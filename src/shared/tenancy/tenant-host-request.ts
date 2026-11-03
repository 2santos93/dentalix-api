import { JwtPayload } from '../crypto/token.service';

export interface TenantHostRequest {
  headers: Record<string, string | string[] | undefined>;
  /** SEC-014: el método decide si una sede desactivada se acepta (lecturas). */
  method?: string;
  /** SEC-014: su `locationId` (si lo trae) no puede ser una sede desactivada. */
  body?: unknown;
  user?: JwtPayload;
  tenantHost?: { host?: string; tenantId: string | null };
}
