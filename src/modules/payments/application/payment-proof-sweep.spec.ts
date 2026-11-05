import { InMemoryFileStorage } from '../../../shared/storage/__fixtures__/in-memory-file-storage';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { JobRegistry } from '../../jobs/application/job-registry';
import { InMemoryPaymentRepository } from './use-cases/__fixtures__/in-memory-payment.repository';
import {
  PROOF_PENDING_SWEEP_CRON,
  PROOF_PENDING_SWEEP_JOB,
  PROOF_PENDING_SWEEP_SCHEDULE,
  PROOF_SWEEP_MAX_DELETES,
  PaymentProofJobs,
  PaymentProofPendingSweep,
} from './payment-proof-sweep';

// DX-389 (M1): barrido de los comprobantes pendientes sin entregar.
const TENANT = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const NOW = new Date('2026-11-05T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pendingKey = (n: number, tenant = TENANT) =>
  `payment-proofs/pending/${tenant}/${uuid(n)}`;

function setup() {
  const storage = new InMemoryFileStorage();
  const repo = new InMemoryPaymentRepository();
  const sweep = new PaymentProofPendingSweep(
    storage,
    repo,
    new TenantContextService(),
  );
  const put = async (key: string, ageHours: number) => {
    await storage.save(key, Buffer.from('x'), 'application/octet-stream');
    storage.touch(key, new Date(NOW.getTime() - ageHours * HOUR));
  };
  return { storage, repo, sweep, put };
}

describe('PaymentProofPendingSweep', () => {
  it('borra los pendientes de más de 24 h y conserva los más jóvenes', async () => {
    const { storage, sweep, put } = setup();
    await put(pendingKey(1), 25);
    await put(pendingKey(2), 23);
    await put(pendingKey(3), 24 * 30);
    const result = await sweep.run(NOW);
    expect(result).toEqual({ scanned: 3, deleted: 2, skipped: 0 });
    expect([...storage.files.keys()]).toEqual([pendingKey(2)]);
  });

  it('nunca toca lo que no está bajo payment-proofs/pending/ (los comprobantes definitivos)', async () => {
    const { storage, sweep, put } = setup();
    const final = `payment-proofs/${TENANT}/${uuid(9)}-aaaaaaaaaaaaaaaa.png`;
    await put(final, 24 * 90);
    await put(`expense-receipts/pending/${TENANT}/${uuid(8)}`, 48);
    await put(pendingKey(1), 48);
    await sweep.run(NOW);
    expect([...storage.files.keys()].sort()).toEqual(
      [final, `expense-receipts/pending/${TENANT}/${uuid(8)}`].sort(),
    );
  });

  it('omite una clave que una fila usa y las que no tienen la forma esperada', async () => {
    const { storage, repo, sweep, put } = setup();
    await put(pendingKey(1), 48);
    await put('payment-proofs/pending/no-es-un-uuid/raro', 48);
    repo.proofs.set('pay-1', {
      uploadId: uuid(1),
      key: pendingKey(1),
      mime: 'image/png',
      size: 1,
      sha256: 'a'.repeat(64),
      name: 'a.png',
    });
    const result = await sweep.run(NOW);
    expect(result).toEqual({ scanned: 2, deleted: 0, skipped: 2 });
    expect(storage.files.size).toBe(2);
  });

  it('es idempotente: la segunda pasada no encuentra nada', async () => {
    const { sweep, put } = setup();
    await put(pendingKey(1), 48);
    await sweep.run(NOW);
    expect(await sweep.run(NOW)).toEqual({
      scanned: 0,
      deleted: 0,
      skipped: 0,
    });
  });

  it('recorre todas las páginas', async () => {
    const { storage, sweep, put } = setup();
    for (let n = 1; n <= 450; n++) await put(pendingKey(n), 48);
    const result = await sweep.run(NOW);
    expect(result.deleted).toBe(450);
    expect(storage.files.size).toBe(0);
  });

  it('con un tope por pasada: lo que sobra lo recoge la siguiente', async () => {
    const { storage, sweep, put } = setup();
    const total = PROOF_SWEEP_MAX_DELETES + 5;
    for (let n = 1; n <= total; n++) await put(pendingKey(n), 48);
    expect((await sweep.run(NOW)).deleted).toBe(PROOF_SWEEP_MAX_DELETES);
    expect(storage.files.size).toBe(5);
    expect((await sweep.run(NOW)).deleted).toBe(5);
  });

  it('se detiene si el trabajo se cancela', async () => {
    const { storage, sweep, put } = setup();
    await put(pendingKey(1), 48);
    const controller = new AbortController();
    controller.abort();
    expect((await sweep.run(NOW, controller.signal)).deleted).toBe(0);
    expect(storage.files.size).toBe(1);
  });

  it('un fallo del almacén al listar se propaga (la cola reintenta)', async () => {
    const { storage, sweep } = setup();
    jest
      .spyOn(storage, 'listObjects')
      .mockRejectedValueOnce(new Error('bucket caído'));
    await expect(sweep.run(NOW)).rejects.toThrow('bucket caído');
  });
});

describe('PaymentProofJobs', () => {
  it('registra el trabajo y lo programa una vez al día como singleton, sin encolar nada al arrancar', () => {
    const registry = new JobRegistry();
    const run = jest.fn();
    const sweep = { run } as unknown as PaymentProofPendingSweep;
    new PaymentProofJobs(registry, sweep).onModuleInit();
    expect(registry.get(PROOF_PENDING_SWEEP_JOB)).toBeDefined();
    expect(registry.schedules()).toEqual([
      expect.objectContaining({
        name: PROOF_PENDING_SWEEP_SCHEDULE,
        cron: PROOF_PENDING_SWEEP_CRON,
        job: PROOF_PENDING_SWEEP_JOB,
        singleton: true,
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it('el trabajo corre el barrido con la hora actual y su señal', async () => {
    const registry = new JobRegistry();
    const run = jest
      .fn()
      .mockResolvedValue({ scanned: 0, deleted: 0, skipped: 0 });
    new PaymentProofJobs(registry, {
      run,
    } as unknown as PaymentProofPendingSweep).onModuleInit();
    const signal = new AbortController().signal;
    await registry
      .get(PROOF_PENDING_SWEEP_JOB)!
      .handle({}, { signal } as never);
    expect(run).toHaveBeenCalledWith(expect.any(Date), signal);
  });
});
