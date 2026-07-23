import { TenantDomainRecord } from '../entities/tenant-domain.entity';

export const TENANT_DOMAIN_REPOSITORY = Symbol('TENANT_DOMAIN_REPOSITORY');

export interface TenantDomainRepository {
  create(input: {
    host: string;
    verifyToken: string;
  }): Promise<TenantDomainRecord>;
  listByTenant(): Promise<TenantDomainRecord[]>;
  findByHostForTenant(host: string): Promise<TenantDomainRecord | null>;
  findById(id: string): Promise<TenantDomainRecord | null>;
  markVerified(id: string): Promise<void>;
}
