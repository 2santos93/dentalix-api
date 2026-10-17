import { Logger } from '@nestjs/common';
import { DomainRecheckSweep, RecheckDomain } from './domain-recheck';
import type { JobQueue } from '../../jobs/application/job-queue.service';
import {
  FakeClock,
  FakeDns,
  InMemoryDomains,
  type StoredDomain,
} from './__fixtures__/fake-domains';

const A = 'tenant-a';
const B = 'tenant-b';
const HOUR = 3_600_000;
const txt = (host: string) => `_dentalix-verify.${host}`;

interface Enqueued {
  name: string;
  payload: Record<string, string>;
  options: { tenantId?: string | null; idempotencyKey?: string };
}

/**
 * Unidad de la re-verificación periódica (SEC-009) con un DNS simulado: el
 * barrido encola una comprobación por dominio VERIFIED (en su clínica) y el
 * handler cuenta los fallos y desactiva al llegar al máximo. La cola se
 * sustituye por una lista y cada trabajo se ejecuta "a mano" con el tenant
 * del trabajo, como haría el worker.
 */
function setup(maxFailures = 3) {
  const store = new InMemoryDomains();
  const clock = new FakeClock();
  const dns = new FakeDns();
  const queued: Enqueued[] = [];
  const jobs = {
    enqueue: jest.fn(
      (
        name: string,
        payload: Record<string, string>,
        options: Enqueued['options'],
      ) => {
        queued.push({ name, payload, options });
        return Promise.resolve({ id: String(queued.length), created: true });
      },
    ),
  } as unknown as JobQueue;
  const sweep = new DomainRecheckSweep(store, jobs, clock, dns);
  const handlerFor = (tenantId: string) =>
    new RecheckDomain(store.as(tenantId), dns, {
      recheckMaxFailures: maxFailures,
    });

  /** Una ronda: barrido + cada comprobación (último intento si `lastAttempt`). */
  async function round(opts: { attempt?: number; maxAttempts?: number } = {}) {
    queued.length = 0;
    await sweep.run();
    for (const job of [...queued]) {
      const tenantId = job.options.tenantId as string;
      await handlerFor(tenantId).handle(job.payload, {
        tenantId,
        attempt: opts.attempt ?? 1,
        maxAttempts: opts.maxAttempts ?? 3,
      });
    }
    clock.advance(HOUR);
  }

  const verified = (tenantId: string, host: string): StoredDomain => {
    const row = store.seed(tenantId, { host, status: 'VERIFIED' });
    dns.records.set(txt(host), [row.verifyToken]);
    return row;
  };

  return { store, clock, dns, queued, sweep, handlerFor, round, verified };
}

describe('re-verificación periódica de dominios (SEC-009, unidad)', () => {
  it('el barrido encola una comprobación por dominio VERIFIED vivo, en SU clínica y con clave por ronda', async () => {
    const { store, sweep, queued, clock, verified } = setup();
    const a = verified(A, 'citas.a.com');
    const b = verified(B, 'citas.b.com');
    store.seed(A, { host: 'pendiente.a.com' });
    store.seed(A, { host: 'off.a.com', status: 'DISABLED' });
    store.seed(B, {
      host: 'borrado.b.com',
      status: 'VERIFIED',
      deletedAt: new Date(0),
    });

    await expect(sweep.run()).resolves.toBe(2);

    const round = clock.current.toISOString();
    expect(
      queued
        .map((q) => ({ ...q, options: { ...q.options } }))
        .sort((x, y) => (x.payload.domainId < y.payload.domainId ? -1 : 1)),
    ).toEqual(
      [a, b]
        .sort((x, y) => (x.id < y.id ? -1 : 1))
        .map((d) => ({
          name: 'domains.recheck',
          payload: { domainId: d.id, round, result: 'found' },
          options: {
            tenantId: d.tenantId,
            idempotencyKey: `domains.recheck:${d.id}:${round}`,
          },
        })),
    );
  });

  it('el barrido pagina por host: más de un lote (500) sin repetir ni saltarse ninguno', async () => {
    const { sweep, queued, verified } = setup();
    for (let i = 0; i < 1203; i += 1) {
      verified(i % 2 ? A : B, `c${String(i).padStart(4, '0')}.x.com`);
    }
    await expect(sweep.run()).resolves.toBe(1203);
    expect(new Set(queued.map((q) => q.payload.domainId)).size).toBe(1203);
  });

  it('con el TXT publicado sigue VERIFIED y apunta la comprobación', async () => {
    const { store, round, verified, clock } = setup();
    const row = verified(A, 'citas.a.com');
    const at = clock.now();
    await round();
    expect(store.rows.find((r) => r.id === row.id)).toMatchObject({
      status: 'VERIFIED',
      failedChecks: 0,
      lastCheckedAt: at,
    });
  });

  it('cuando el TXT desaparece, tras N=3 comprobaciones seguidas pasa a DISABLED (y no antes)', async () => {
    const { store, dns, round, verified, clock } = setup(3);
    const row = verified(A, 'citas.a.com');
    const other = verified(B, 'citas.b.com');
    dns.records.delete(txt(row.host));

    await round();
    await round();
    expect(store.rows.find((r) => r.id === row.id)).toMatchObject({
      status: 'VERIFIED',
      failedChecks: 2,
    });
    const third = clock.now();
    await round();
    expect(store.rows.find((r) => r.id === row.id)).toMatchObject({
      status: 'DISABLED',
      failedChecks: 3,
      disabledAt: third,
    });
    // El de la otra clínica, con su TXT, no se toca.
    expect(store.rows.find((r) => r.id === other.id)).toMatchObject({
      status: 'VERIFIED',
      failedChecks: 0,
    });
    // Un DISABLED ya no entra en el barrido.
    await round();
    expect(store.rows.find((r) => r.id === row.id)?.failedChecks).toBe(3);
  });

  it('N es configurable (1 = a la primera)', async () => {
    const { store, dns, round, verified } = setup(1);
    const row = verified(A, 'citas.a.com');
    dns.records.delete(txt(row.host));
    await round();
    expect(store.rows[0].status).toBe('DISABLED');
  });

  it('los fallos tienen que ser SEGUIDOS: encontrar el TXT reinicia la cuenta', async () => {
    const { store, dns, round, verified } = setup(3);
    const row = verified(A, 'citas.a.com');
    dns.records.delete(txt(row.host));
    await round();
    await round();
    dns.records.set(txt(row.host), [row.verifyToken]);
    await round();
    dns.records.delete(txt(row.host));
    await round();
    await round();
    expect(store.rows[0]).toMatchObject({
      status: 'VERIFIED',
      failedChecks: 2,
    });
  });

  it('un TXT con OTRO token (el dominio cambió de manos) cuenta como fallo', async () => {
    const { store, dns, round, verified } = setup(1);
    const row = verified(A, 'citas.a.com');
    dns.records.set(txt(row.host), ['dentalix-verify=de-otro']);
    await round();
    expect(store.rows[0].status).toBe('DISABLED');
  });

  it('un DNS que no responde (timeout, SERVFAIL…) se reintenta y NO cuenta como fallo, ni en el último intento', async () => {
    const { store, dns, sweep, queued, handlerFor, verified, round } = setup(3);
    const row = verified(A, 'citas.a.com');
    // Dos fallos definitivos previos (TXT ausente).
    dns.records.delete(txt(row.host));
    await round();
    await round();
    expect(store.rows[0].failedChecks).toBe(2);

    // Ahora el DNS no responde: ni suma ni reinicia la cuenta.
    dns.failing.add(txt(row.host));
    queued.length = 0;
    await sweep.run();
    const [job] = queued;
    const handler = handlerFor(A);
    await expect(
      handler.handle(job.payload, { tenantId: A, attempt: 1, maxAttempts: 3 }),
    ).rejects.toThrow('DNS lookup failed');
    await expect(
      handler.handle(job.payload, { tenantId: A, attempt: 3, maxAttempts: 3 }),
    ).resolves.toBeUndefined();
    expect(store.rows[0]).toMatchObject({
      status: 'VERIFIED',
      failedChecks: 2,
    });
  });

  it('un resolver caído durante muchas rondas no desactiva ningún dominio', async () => {
    const { store, dns, round, verified } = setup(1);
    const a = verified(A, 'citas.a.com');
    const b = verified(B, 'citas.b.com');
    dns.failing.add(txt(a.host));
    dns.failing.add(txt(b.host));
    for (let i = 0; i < 5; i += 1) await round({ attempt: 3, maxAttempts: 3 });
    expect(store.rows.map((r) => r.status)).toEqual(['VERIFIED', 'VERIFIED']);
    expect(store.rows.map((r) => r.failedChecks)).toEqual([0, 0]);
  });

  it('idempotente: entregar dos veces la comprobación de una ronda no cuenta dos fallos', async () => {
    const { store, dns, sweep, queued, handlerFor, verified } = setup(3);
    const row = verified(A, 'citas.a.com');
    dns.records.delete(txt(row.host));
    await sweep.run();
    const [job] = queued;
    await handlerFor(A).handle(job.payload, {
      tenantId: A,
      attempt: 1,
      maxAttempts: 3,
    });
    await handlerFor(A).handle(job.payload, {
      tenantId: A,
      attempt: 1,
      maxAttempts: 3,
    });
    expect(store.rows[0].failedChecks).toBe(1);
  });

  it('no toca un dominio borrado entre el barrido y la comprobación', async () => {
    const { store, dns, sweep, queued, handlerFor, verified } = setup(1);
    const row = verified(A, 'citas.a.com');
    dns.records.delete(txt(row.host));
    await sweep.run();
    row.deletedAt = new Date();
    await handlerFor(A).handle(queued[0].payload, {
      tenantId: A,
      attempt: 1,
      maxAttempts: 3,
    });
    expect(store.rows[0]).toMatchObject({
      status: 'VERIFIED',
      failedChecks: 0,
    });
    // Solo la consulta del barrido: la comprobación ni lo mira.
    expect(dns.lookups).toEqual([txt(row.host)]);
  });

  it('la comprobación corre en la clínica del trabajo: el id de un dominio de otra clínica no se toca', async () => {
    const { store, dns, sweep, queued, handlerFor, verified } = setup(1);
    const row = verified(B, 'citas.b.com');
    dns.records.delete(txt(row.host));
    await sweep.run();
    await handlerFor(A).handle(queued[0].payload, {
      tenantId: A,
      attempt: 3,
      maxAttempts: 3,
    });
    expect(store.rows[0].status).toBe('VERIFIED');
  });

  it('la ronda es la hora del barrido: repetirlo en la misma hora (reintento, arriendo perdido) no suma otro fallo', async () => {
    const { store, dns, sweep, queued, clock, handlerFor, verified } = setup(3);
    const row = verified(A, 'citas.a.com');
    dns.records.delete(txt(row.host));
    clock.advance(29 * 60_000);
    await sweep.run();
    clock.advance(4 * 60_000);
    await sweep.run();
    expect(queued).toHaveLength(2);
    expect(queued[0].options.idempotencyKey).toBe(
      queued[1].options.idempotencyKey,
    );
    expect(queued[0].payload.round).toBe('2026-10-17T12:00:00.000Z');
    for (const job of queued) {
      await handlerFor(A).handle(job.payload, {
        tenantId: A,
        attempt: 1,
        maxAttempts: 3,
      });
    }
    expect(store.rows[0].failedChecks).toBe(1);
  });

  it('rechaza un payload inválido', async () => {
    const { handlerFor } = setup();
    await expect(
      handlerFor(A).handle(
        { domainId: 'x', round: 'y' },
        { tenantId: A, attempt: 1, maxAttempts: 3 },
      ),
    ).rejects.toThrow('payload inválido');
  });

  describe('freno del barrido (DX-220, OPS-033)', () => {
    /** `n` dominios VERIFIED repartidos entre las dos clínicas. */
    function fleet(n: number) {
      const ctx = setup(1);
      const rows = Array.from({ length: n }, (_, i) =>
        ctx.verified(i % 2 ? A : B, `c${i}.x.com`),
      );
      return { ...ctx, rows };
    }

    it('si más del 50 % de los dominios (y hay ≥ 4) dan fallo definitivo, la ronda no cuenta: no suma fallos a ninguno y deja domains.recheck_suspect', async () => {
      const { store, dns, sweep, queued, rows } = fleet(5);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      // El DNS propio contesta NXDOMAIN para casi todo (3 de 5).
      for (const row of rows.slice(0, 3)) dns.records.delete(txt(row.host));

      await expect(sweep.run()).resolves.toBe(0);

      expect(queued).toEqual([]);
      expect(store.rows.map((r) => [r.status, r.failedChecks])).toEqual(
        rows.map(() => ['VERIFIED', 0]),
      );
      expect(warn).toHaveBeenCalledWith({
        event: 'domains.recheck_suspect',
        round: expect.any(String) as string,
        domains: 5,
        missing: 3,
        inconclusive: 0,
      });
      // Sin hosts ni tokens en el log.
      expect(JSON.stringify(warn.mock.calls)).not.toContain('.x.com');
      warn.mockRestore();
    });

    it('con N=1 (desactivar a la primera), una ronda sospechosa tampoco desactiva a nadie', async () => {
      const { store, dns, round, rows } = fleet(4);
      for (const row of rows) dns.records.delete(txt(row.host));
      await round();
      await round();
      expect(store.rows.every((r) => r.status === 'VERIFIED')).toBe(true);
      expect(store.rows.every((r) => r.failedChecks === 0)).toBe(true);
    });

    it('justo el 50 % no frena: los que fallan suman y los demás reinician', async () => {
      const { store, dns, round, rows } = fleet(4);
      for (const row of rows.slice(0, 2)) dns.records.delete(txt(row.host));
      await round();
      expect(store.rows.map((r) => r.status).sort()).toEqual([
        'DISABLED',
        'DISABLED',
        'VERIFIED',
        'VERIFIED',
      ]);
    });

    it('con menos de 4 dominios no frena (una mayoría de fallos es normal)', async () => {
      const { store, dns, round, rows } = fleet(3);
      for (const row of rows) dns.records.delete(txt(row.host));
      await round();
      expect(store.rows.every((r) => r.status === 'DISABLED')).toBe(true);
    });

    it('los que no responden (timeout) no cuentan como fallo definitivo ni para el freno: van sin resultado y su trabajo consulta el DNS', async () => {
      const { dns, sweep, queued, rows } = fleet(4);
      dns.failing.add(txt(rows[0].host));
      dns.failing.add(txt(rows[1].host));
      dns.failing.add(txt(rows[2].host));
      dns.records.delete(txt(rows[3].host));

      await expect(sweep.run()).resolves.toBe(4);

      const byId = new Map(queued.map((q) => [q.payload.domainId, q.payload]));
      expect(byId.get(rows[0].id)?.result).toBeUndefined();
      expect(byId.get(rows[3].id)?.result).toBe('missing');
    });

    it('cada dominio se consulta UNA vez por ronda (el barrido), no dos', async () => {
      const { dns, round, rows } = fleet(6);
      await round();
      expect(dns.lookups.sort()).toEqual(rows.map((r) => txt(r.host)).sort());
    });

    it('rechaza un resultado que no es found/missing', async () => {
      const { handlerFor, rows } = fleet(1);
      await expect(
        handlerFor(rows[0].tenantId).handle(
          {
            domainId: rows[0].id,
            round: new Date().toISOString(),
            result: 'quizá',
          },
          { tenantId: rows[0].tenantId, attempt: 1, maxAttempts: 3 },
        ),
      ).rejects.toThrow('payload inválido');
    });
  });
});
