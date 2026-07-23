import { Injectable } from '@nestjs/common';
import { resolveTxt } from 'node:dns/promises';
import type { DnsResolver } from '../../domain/ports/dns-resolver.port';

@Injectable()
export class NodeDnsResolver implements DnsResolver {
  async resolveTxt(name: string): Promise<string[]> {
    try {
      // resolveTxt returns string[][] (each record can be chunked); join chunks.
      const records = await resolveTxt(name);
      return records.map((chunks) => chunks.join(''));
    } catch {
      // ENOTFOUND / ENODATA / SERVFAIL -> treat as "no record yet".
      return [];
    }
  }
}
