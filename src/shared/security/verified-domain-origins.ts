import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { VerifiedDomainLookup } from './security-settings';

/** Cuánto vale una respuesta (positiva o negativa) de la caché. */
export const VERIFIED_DOMAIN_TTL_MS = 60_000;

/**
 * Tope de hosts en la caché: cualquiera puede mandar `Origin` arbitrarios, así
 * que sin tope la caché crecería sin límite. Al llenarse se descarta el más
 * antiguo (orden de inserción del Map).
 */
export const VERIFIED_DOMAIN_CACHE_MAX = 5_000;

interface Entry {
  verified: boolean;
  expiresAt: number;
}

/**
 * SEC-021: ¿es `host` un dominio propio VERIFIED vivo de una clínica viva? La
 * misma condición con la que TenantResolverService enruta un dominio propio,
 * así que un PENDING (caducado o no), un DISABLED o uno borrado no valen.
 *
 * La consultan CORS y el check de Origin del refresh por cookie en cada
 * petición con `Origin` de un dominio propio, así que va cacheada en memoria
 * del proceso con un TTL corto (60 s, también las negativas). Verificar o
 * eliminar un dominio en ESTE proceso la invalida al momento; en otras
 * instancias (y la desactivación por la re-verificación, que corre en el
 * worker) surte efecto al caducar la entrada. Un fallo de la base de datos no
 * se cachea y se propaga (CORS responde con error, no deja pasar).
 */
@Injectable()
export class VerifiedDomainOrigins implements VerifiedDomainLookup {
  private readonly cache = new Map<string, Entry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly now: () => number = Date.now,
  ) {}

  async isVerified(rawHost: string): Promise<boolean> {
    const host = rawHost.toLowerCase();
    const cached = this.cache.get(host);
    if (cached && cached.expiresAt > this.now()) return cached.verified;

    const domain = await this.prisma.tenantDomain.findFirst({
      where: {
        host,
        status: 'VERIFIED',
        deletedAt: null,
        tenant: { deletedAt: null },
      },
      select: { id: true },
    });
    const verified = domain != null;
    this.remember(host, verified);
    return verified;
  }

  /** Olvida `host` (o toda la caché sin argumento). */
  invalidate(host?: string): void {
    if (host == null) {
      this.cache.clear();
      return;
    }
    // eslint-disable-next-line no-restricted-syntax -- Map en memoria de la caché, no un dato de la BD.
    this.cache.delete(host.toLowerCase());
  }

  private remember(host: string, verified: boolean): void {
    // Reinsertar lo pone al final (el más reciente) del orden del Map.
    // eslint-disable-next-line no-restricted-syntax -- Map en memoria de la caché, no un dato de la BD.
    this.cache.delete(host);
    if (this.cache.size >= VERIFIED_DOMAIN_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      // eslint-disable-next-line no-restricted-syntax -- Map en memoria de la caché, no un dato de la BD.
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(host, {
      verified,
      expiresAt: this.now() + VERIFIED_DOMAIN_TTL_MS,
    });
  }
}
