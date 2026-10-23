import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  S3FileStorage,
  createS3Client,
} from '../../src/shared/storage/s3-file-storage';
import type { S3StorageConfig } from '../../src/shared/storage/storage-config';
import {
  STORAGE_UNAVAILABLE_MESSAGE,
  StorageUnavailableError,
} from '../../src/shared/storage/storage-errors';
import { StorageOpLogger } from '../../src/shared/storage/storage-op-log';
import {
  startHungTcpServer,
  waitUntil,
  type HungTcpServer,
} from '../support/hung-tcp-server';

const REQUEST_TIMEOUT_MS = 800;
/** Margen sobre el plazo: arrancar la petición, el backoff y el event loop. */
const MARGIN_MS = 700;

// DX-259 (OPS-039): con el almacén colgado (acepta la conexión y no responde,
// como un MinIO en pausa) cada operación falla dentro de su plazo con el 503
// en español, y el cliente cierra los sockets en vez de dejarlos colgados.
// Sin docker: el «S3» es un servidor TCP que no contesta.
describe('S3FileStorage con el almacén sin responder (int)', () => {
  let hung: HungTcpServer;
  let storage: S3FileStorage;
  let dir: string;
  const lines: Record<string, unknown>[] = [];

  beforeAll(async () => {
    hung = await startHungTcpServer();
    dir = mkdtempSync(path.join(tmpdir(), 's3-timeouts-'));
    const cfg: S3StorageConfig = {
      driver: 's3',
      publicBaseUrl: 'http://localhost:3000/api/v1/files',
      bucket: 'dentalix-colgado',
      region: 'us-east-1',
      endpoint: hung.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: 'k', secretAccessKey: 's' },
      serverSideEncryption: undefined,
      tuning: {
        connectTimeoutMs: 300,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        maxSockets: 4,
        maxAttempts: 3,
      },
    };
    const sink = (line: unknown) => lines.push(line as Record<string, unknown>);
    storage = new S3FileStorage(
      createS3Client(cfg),
      cfg,
      new StorageOpLogger({ log: sink, warn: sink }),
    );
  });

  afterAll(async () => {
    await hung.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function expectUnavailableInTime(op: () => Promise<unknown>) {
    const started = Date.now();
    const error = await op().then(
      () => null,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - started;
    expect(error).toBeInstanceOf(StorageUnavailableError);
    expect((error as StorageUnavailableError).getStatus()).toBe(503);
    expect((error as StorageUnavailableError).message).toBe(
      STORAGE_UNAVAILABLE_MESSAGE,
    );
    expect(elapsed).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS + MARGIN_MS);
    // El socket se cierra: nada se queda colgado contra el almacén.
    await waitUntil(() => hung.openSockets() === 0, 1000);
  }

  it.each([
    ['stat (HeadObject)', () => storage.stat('patient-documents/pending/t/d')],
    ['read (GetObject)', () => storage.read('avatars/u1.png')],
    ['openRead (avatar)', () => storage.openRead('avatars/u1.png')],
    [
      'readRange (sniff)',
      () => storage.readRange('patient-documents/pending/t/d', 0, 65536, '"e"'),
    ],
    [
      'save (PutObject)',
      () => storage.save('avatars/u1.png', Buffer.from('x'), 'image/png'),
    ],
    ['checkReachable (HeadBucket)', () => storage.checkReachable()],
  ])(
    '%s falla en ≤ plazo + margen con 503 y sin sockets colgados',
    async (_label, op) => {
      const before = hung.accepted();
      await expectUnavailableInTime(op);
      expect(hung.accepted()).toBeGreaterThan(before);
    },
  );

  it('saveFile (Upload en streaming de un temporal) también', async () => {
    const file = path.join(dir, 'avatar.png');
    writeFileSync(file, Buffer.alloc(64 * 1024, 1));
    await expectUnavailableInTime(() =>
      storage.saveFile('avatars/u1-0123456789abcdef.png', file, 'image/png'),
    );
  });

  it('diez operaciones a la vez no esperan en cola más allá del plazo (sockets acotados y liberados)', async () => {
    const started = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        storage.stat(`patient-documents/pending/t/d${i}`),
      ),
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(Date.now() - started).toBeLessThanOrEqual(
      REQUEST_TIMEOUT_MS + MARGIN_MS,
    );
    await waitUntil(() => hung.openSockets() === 0, 1000);
  });

  it('cada fallo deja su storage.op con outcome timeout y sin la clave', () => {
    const timeouts = lines.filter((l) => l.outcome === 'timeout');
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts[0]).toMatchObject({ event: 'storage.op', driver: 's3' });
    expect(JSON.stringify(lines)).not.toMatch(/patient-documents|avatars|u1/);
  });

  it('un puerto cerrado (conexión rechazada) es 503 al momento', async () => {
    const closed = await startHungTcpServer();
    const endpoint = closed.endpoint;
    await closed.close();
    const cfg: S3StorageConfig = {
      driver: 's3',
      publicBaseUrl: 'http://localhost:3000/api/v1/files',
      bucket: 'dentalix-cerrado',
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: 'k', secretAccessKey: 's' },
      serverSideEncryption: undefined,
      tuning: {
        connectTimeoutMs: 300,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        maxSockets: 4,
        maxAttempts: 2,
      },
    };
    const refused = new S3FileStorage(
      createS3Client(cfg),
      cfg,
      new StorageOpLogger({ log: () => undefined, warn: () => undefined }),
    );
    const started = Date.now();
    await expect(refused.stat('avatars/u1.png')).rejects.toBeInstanceOf(
      StorageUnavailableError,
    );
    expect(Date.now() - started).toBeLessThanOrEqual(
      REQUEST_TIMEOUT_MS + MARGIN_MS,
    );
  });
});
