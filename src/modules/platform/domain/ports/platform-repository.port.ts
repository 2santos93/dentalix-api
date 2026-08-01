/** Una clínica tal como la ve el superadmin en el listado de plataforma. */
export interface PlatformTenant {
  id: string;
  name: string;
  subdomain: string;
  createdAt: Date;
}

export const PLATFORM_REPOSITORY = Symbol('PLATFORM_REPOSITORY');

export interface PlatformRepository {
  /** Todas las clínicas, ordenadas por nombre. */
  listTenants(): Promise<PlatformTenant[]>;
  /** Re-chequeo en DB del flag de plataforma (revocarlo debe surtir efecto sin esperar a que expire el token). */
  isPlatformAdmin(userId: string): Promise<boolean>;
}
