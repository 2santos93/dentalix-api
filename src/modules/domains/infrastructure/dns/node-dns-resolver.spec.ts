import { resolveTxt } from 'node:dns/promises';
import { NodeDnsResolver } from './node-dns-resolver';
import { DnsLookupError } from '../../domain/ports/dns-resolver.port';

jest.mock('node:dns/promises', () => ({ resolveTxt: jest.fn() }));

const mocked = resolveTxt as jest.MockedFunction<typeof resolveTxt>;

function dnsError(code: string): Error {
  return Object.assign(new Error(`queryTxt ${code}`), { code });
}

describe('NodeDnsResolver', () => {
  beforeEach(() => mocked.mockReset());

  it('joins the chunks of each TXT record', async () => {
    mocked.mockResolvedValue([['dentalix-verify=', 'abc'], ['otro']]);
    await expect(
      new NodeDnsResolver().resolveTxt('_dentalix-verify.citas.a.com'),
    ).resolves.toEqual(['dentalix-verify=abc', 'otro']);
  });

  it.each(['ENOTFOUND', 'ENODATA'])(
    'treats %s (no such name / no TXT) as "no record"',
    async (code) => {
      mocked.mockRejectedValue(dnsError(code));
      await expect(
        new NodeDnsResolver().resolveTxt('x.a.com'),
      ).resolves.toEqual([]);
    },
  );

  it.each(['ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', 'EREFUSED'])(
    'SEC-009: %s means "unknown", not "no record": throws DnsLookupError',
    async (code) => {
      mocked.mockRejectedValue(dnsError(code));
      const error = await new NodeDnsResolver()
        .resolveTxt('x.a.com')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DnsLookupError);
      expect((error as DnsLookupError).code).toBe(code);
    },
  );
});
