import { Injectable } from '@nestjs/common';
import { resolveTxt } from 'node:dns/promises';
import {
  DnsLookupError,
  type DnsResolver,
} from '../../domain/ports/dns-resolver.port';

/** Respuestas definitivas: el nombre no existe o no tiene TXT. */
const NO_RECORD = new Set(['ENOTFOUND', 'ENODATA']);

@Injectable()
export class NodeDnsResolver implements DnsResolver {
  async resolveTxt(name: string): Promise<string[]> {
    try {
      // resolveTxt returns string[][] (each record can be chunked); join chunks.
      const records = await resolveTxt(name);
      return records.map((chunks) => chunks.join(''));
    } catch (error) {
      const code =
        error instanceof Error &&
        typeof (error as { code?: unknown }).code === 'string'
          ? (error as Error & { code: string }).code
          : 'UNKNOWN';
      if (NO_RECORD.has(code)) return [];
      // SERVFAIL / ETIMEOUT / ECONNREFUSED…: no se sabe; quien llama decide.
      throw new DnsLookupError(code);
    }
  }
}
