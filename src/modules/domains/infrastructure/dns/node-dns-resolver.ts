import { Inject, Injectable } from '@nestjs/common';
import { Resolver } from 'node:dns/promises';
import {
  DnsLookupError,
  type DnsResolver,
} from '../../domain/ports/dns-resolver.port';
import { DOMAINS_CONFIG, type DomainsConfig } from '../domains-config';

/** Respuestas definitivas: el nombre no existe o no tiene TXT. */
const NO_RECORD = new Set(['ENOTFOUND', 'ENODATA']);

/** Lo que se usa de `Resolver` (los tests lo sustituyen). */
export interface TxtResolver {
  resolveTxt(name: string): Promise<string[][]>;
  cancel(): void;
}

/**
 * DX-220 (OPS-033): un `Resolver` PROPIO por consulta, con `timeout` y
 * `tries` acotados (DNS_RESOLVER_TIMEOUT_MS = 3000, DNS_RESOLVER_TRIES = 2),
 * en vez del resolver global del proceso sin tope. Además, un plazo duro de
 * timeout × tries: c-ares alarga el timeout en cada reintento y lo multiplica
 * por cada servidor de /etc/resolv.conf, así que sin él un DNS mudo podía
 * ocupar bastante más. Al vencer, `cancel()` (de ESE resolver, no de las
 * demás consultas en vuelo) y ETIMEOUT: «no se sabe», nunca «no hay
 * registro».
 */
@Injectable()
export class NodeDnsResolver implements DnsResolver {
  constructor(
    @Inject(DOMAINS_CONFIG)
    private readonly config: Pick<DomainsConfig, 'dnsTimeoutMs' | 'dnsTries'>,
  ) {}

  /** Plazo total de una consulta, en ms. */
  get deadlineMs(): number {
    return this.config.dnsTimeoutMs * this.config.dnsTries;
  }

  protected createResolver(): TxtResolver {
    return new Resolver({
      timeout: this.config.dnsTimeoutMs,
      tries: this.config.dnsTries,
    });
  }

  async resolveTxt(name: string): Promise<string[]> {
    const resolver = this.createResolver();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        resolver.cancel();
        reject(new DnsLookupError('ETIMEOUT'));
      }, this.deadlineMs);
    });
    try {
      // resolveTxt returns string[][] (each record can be chunked); join chunks.
      const records = await Promise.race([resolver.resolveTxt(name), deadline]);
      return records.map((chunks) => chunks.join(''));
    } catch (error) {
      if (error instanceof DnsLookupError) throw error;
      const code =
        error instanceof Error &&
        typeof (error as { code?: unknown }).code === 'string'
          ? (error as Error & { code: string }).code
          : 'UNKNOWN';
      if (NO_RECORD.has(code)) return [];
      // SERVFAIL / ETIMEOUT / ECONNREFUSED / ECANCELLED…: no se sabe; quien
      // llama decide.
      throw new DnsLookupError(code);
    } finally {
      clearTimeout(timer);
    }
  }
}
