export type TenantDomainStatus = 'PENDING' | 'VERIFIED';

export interface TenantDomainRecord {
  id: string;
  host: string;
  status: TenantDomainStatus;
  verifyToken: string;
  verifiedAt: Date | null;
  createdAt: Date;
}
