import { createSocket, type Socket } from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { NodeDnsResolver, type TxtResolver } from './node-dns-resolver';
import { DnsLookupError } from '../../domain/ports/dns-resolver.port';

function dnsError(code: string): Error {
  return Object.assign(new Error(`queryTxt ${code}`), { code });
}

/** NodeDnsResolver con un resolver falso (y lo que se le pidió). */
class FakeResolverDns extends NodeDnsResolver {
  readonly cancelled: number[] = [];
  created = 0;

  constructor(
    private readonly answer: () => Promise<string[][]>,
    config = { dnsTimeoutMs: 3000, dnsTries: 2 },
  ) {
    super(config);
  }

  protected override createResolver(): TxtResolver {
    const n = (this.created += 1);
    return {
      resolveTxt: () => this.answer(),
      cancel: () => this.cancelled.push(n),
    };
  }
}

const config = { dnsTimeoutMs: 3000, dnsTries: 2 };

describe('NodeDnsResolver', () => {
  it('joins the chunks of each TXT record', async () => {
    const dns = new FakeResolverDns(() =>
      Promise.resolve([['dentalix-verify=', 'abc'], ['otro']]),
    );
    await expect(
      dns.resolveTxt('_dentalix-verify.citas.a.com'),
    ).resolves.toEqual(['dentalix-verify=abc', 'otro']);
  });

  it.each(['ENOTFOUND', 'ENODATA'])(
    'treats %s (no such name / no TXT) as "no record"',
    async (code) => {
      const dns = new FakeResolverDns(() => Promise.reject(dnsError(code)));
      await expect(dns.resolveTxt('x.a.com')).resolves.toEqual([]);
    },
  );

  it.each(['ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', 'EREFUSED', 'ECANCELLED'])(
    'SEC-009: %s means "unknown", not "no record": throws DnsLookupError',
    async (code) => {
      const dns = new FakeResolverDns(() => Promise.reject(dnsError(code)));
      const error = await dns.resolveTxt('x.a.com').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DnsLookupError);
      expect((error as DnsLookupError).code).toBe(code);
    },
  );

  describe('DX-220 (OPS-033): resolver propio con timeout', () => {
    afterEach(() => jest.useRealTimers());

    it('crea un Resolver propio con timeout 3000 ms y 2 intentos (configurables)', () => {
      class Spy extends NodeDnsResolver {
        expose(): TxtResolver {
          return this.createResolver();
        }
      }
      expect(new Spy(config).expose()).toBeInstanceOf(Resolver);
      expect(new Spy(config).deadlineMs).toBe(6000);
      expect(new Spy({ dnsTimeoutMs: 1500, dnsTries: 3 }).deadlineMs).toBe(
        4500,
      );
    });

    it('un DNS que no responde ocupa como mucho timeout × intentos (6 s): ETIMEOUT y cancela SU consulta', async () => {
      jest.useFakeTimers();
      const dns = new FakeResolverDns(() => new Promise<string[][]>(() => {}));
      let settled: unknown = 'pending';
      const lookup = dns.resolveTxt('x.a.com').then(
        () => (settled = 'resolved'),
        (e: unknown) => (settled = e),
      );

      await jest.advanceTimersByTimeAsync(5999);
      expect(settled).toBe('pending');
      expect(dns.cancelled).toEqual([]);

      await jest.advanceTimersByTimeAsync(1);
      await lookup;
      expect(settled).toBeInstanceOf(DnsLookupError);
      expect((settled as DnsLookupError).code).toBe('ETIMEOUT');
      expect(dns.cancelled).toEqual([1]);
    });

    it('cada consulta tiene su resolver: cancelar una que vence no corta las demás', async () => {
      jest.useFakeTimers();
      let call = 0;
      const dns = new FakeResolverDns(() => {
        call += 1;
        return call === 1
          ? new Promise<string[][]>(() => {})
          : Promise.resolve([['ok']]);
      });
      const slow = dns.resolveTxt('lento.a.com').catch((e: unknown) => e);
      await expect(dns.resolveTxt('rapido.a.com')).resolves.toEqual(['ok']);
      await jest.advanceTimersByTimeAsync(6000);
      expect(await slow).toBeInstanceOf(DnsLookupError);
      expect(dns.cancelled).toEqual([1]);
    });

    describe('contra un servidor DNS real que no contesta (UDP mudo)', () => {
      let socket: Socket;
      let server: string;

      beforeAll(async () => {
        socket = createSocket('udp4');
        // Recibe y no contesta nunca.
        socket.on('message', () => undefined);
        await new Promise<void>((resolve) =>
          socket.bind(0, '127.0.0.1', resolve),
        );
        server = `127.0.0.1:${socket.address().port}`;
      });

      afterAll(() => {
        socket.close();
      });

      it('se rinde en torno a timeout × intentos y da DnsLookupError, no «sin registro»', async () => {
        class MuteServerDns extends NodeDnsResolver {
          protected override createResolver(): TxtResolver {
            const resolver = super.createResolver() as Resolver;
            resolver.setServers([server]);
            return resolver;
          }
        }
        const dns = new MuteServerDns({ dnsTimeoutMs: 100, dnsTries: 2 });
        const started = Date.now();
        const error = await dns
          .resolveTxt('_dentalix-verify.citas.a.com')
          .catch((e: unknown) => e);
        const elapsed = Date.now() - started;

        expect(error).toBeInstanceOf(DnsLookupError);
        expect(['ETIMEOUT', 'ECANCELLED']).toContain(
          (error as DnsLookupError).code,
        );
        // Plazo duro de 200 ms (más el margen del bucle de eventos).
        expect(elapsed).toBeLessThan(1000);
      });
    });
  });
});
