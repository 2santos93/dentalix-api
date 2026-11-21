import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import type { FileStoragePort } from '../../../shared/storage/file-storage.port';
import type { TenantLinkBaseService } from '../../../shared/tenancy/tenant-link-base.service';
import { ZipTooLargeError } from '../../../shared/zip/zip-writer';
import type { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import {
  CLINIC_EXPORT_PURGE_JOB,
  EXPORT_PAGE_SIZE,
} from '../domain/clinic-export';
import type { ExportRow } from '../domain/csv-format';
import { EXPORT_CATALOG } from '../domain/export-catalog';
import type {
  ClinicExportRepository,
  CompletedExport,
  InTx,
} from '../domain/ports/clinic-export-repository.port';
import {
  ClinicExportBuilder,
  type ClinicExportJobQueue,
} from './clinic-export-builder';

const TENANT = '11111111-1111-4111-8111-111111111111';
const EXPORT_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-21T13:00:00Z');

/** Lector mínimo del ZIP: nombre → contenido. */
function unzip(zip: Buffer): Map<string, string> {
  const eocd = zip.length - 22;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const compressed = zip.readUInt32LE(p + 20);
    const nameLength = zip.readUInt16LE(p + 28);
    const offset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    const start = offset + 30 + zip.readUInt16LE(offset + 26);
    out.set(
      name,
      inflateRawSync(zip.subarray(start, start + compressed)).toString('utf8'),
    );
    p += 46 + nameLength;
  }
  return out;
}

function patientRows(n: number): ExportRow[] {
  return Array.from({ length: n }, (_, i) => ({
    k: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    z: null,
    c0: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    c1: String(i + 1),
    c2: i === 0 ? '=1+1' : `Paciente ${i}`,
    c3: 'Caracas',
  }));
}

function setup(options: { patients?: number; started?: boolean } = {}) {
  const patients = patientRows(options.patients ?? 0);
  const storageDelete = jest.fn(() => Promise.resolve());
  const markFileDeleted = jest.fn(() => Promise.resolve());
  const pageCalls: { file: string; after: string | null; limit: number }[] = [];
  const completed: CompletedExport[] = [];
  const failed: string[] = [];
  const saved: { key: string; bytes: Buffer }[] = [];
  const txInserts: string[] = [];
  const kicks: string[] = [];
  const enqueued: { name: string; runAt?: Date; key?: string }[] = [];
  const repo: ClinicExportRepository = {
    isActiveAdmin: jest.fn(),
    request: jest.fn(),
    list: jest.fn(),
    consumeDownload: jest.fn(),
    start: jest.fn(() =>
      Promise.resolve(
        options.started === false
          ? null
          : { requestedById: 'u-admin', requestedAt: NOW },
      ),
    ),
    complete: jest.fn(
      async (_id: string, data: CompletedExport, after: InTx) => {
        completed.push(data);
        await after({} as never);
        return true;
      },
    ),
    fail: jest.fn((_id: string, code: string) => {
      failed.push(code);
      return Promise.resolve();
    }),
    fileToPurge: jest.fn(() => Promise.resolve('clinic-exports/x/y.zip')),
    markFileDeleted,
    activeAdmins: jest.fn(() =>
      Promise.resolve([
        {
          userId: 'u-admin',
          fullName: 'Ana Rodríguez',
          email: 'ana@clinica.test',
        },
        {
          userId: 'u-admin2',
          fullName: 'Luis Pérez',
          email: 'luis@clinica.test',
        },
      ]),
    ),
    clinic: jest.fn(() =>
      Promise.resolve({
        name: 'Clínica Ávila',
        region: {
          timeZone: 'America/Caracas',
          locale: 'es-VE',
          hourCycle: 'h12' as const,
        },
      }),
    ),
    page: jest.fn((file: string, after: string | null, limit: number) => {
      pageCalls.push({ file, after, limit });
      if (file !== 'pacientes.csv') return Promise.resolve([]);
      const from = after ? patients.findIndex((r) => r.k === after) + 1 : 0;
      return Promise.resolve(patients.slice(from, from + limit));
    }),
  };
  const storage = {
    saveFile: jest.fn((key: string, file: string) => {
      saved.push({ key, bytes: readFileSync(file) });
      return Promise.resolve();
    }),
    delete: storageDelete,
  } as unknown as FileStoragePort;
  const queue: ClinicExportJobQueue = {
    enqueue: jest.fn((name, _payload, opts) => {
      enqueued.push({ name, runAt: opts.runAt, key: opts.idempotencyKey });
      return Promise.resolve({ id: 'j', created: true });
    }),
  };
  const prepareInTx = jest.fn((input: { to: string; vars: object }) =>
    Promise.resolve({
      insert: () => {
        txInserts.push(input.to);
        return Promise.resolve({ id: input.to });
      },
      kick: () => kicks.push(input.to),
    }),
  );
  const email = { prepareInTx } as unknown as EmailOutbox;
  const links = {
    forTenant: () => Promise.resolve('https://avila.dentalix.app'),
  } as unknown as TenantLinkBaseService;
  const builder = new ClinicExportBuilder(
    repo,
    storage,
    queue,
    email,
    links,
    () => NOW,
  );
  const ctx = { tenantId: TENANT, attempt: 1, maxAttempts: 3 };
  return {
    builder,
    ctx,
    repo,
    storage,
    email,
    pageCalls,
    completed,
    failed,
    saved,
    txInserts,
    kicks,
    enqueued,
    storageDelete,
    markFileDeleted,
    prepareInTx,
  };
}

describe('ClinicExportBuilder (DX-053)', () => {
  it('genera el ZIP con todos los ficheros del catálogo y el LEEME, lo sube y queda READY', async () => {
    const t = setup({ patients: 3 });
    await expect(t.builder.build(EXPORT_ID, t.ctx)).resolves.toBe('READY');
    expect(t.saved).toHaveLength(1);
    expect(t.saved[0].key).toBe(`clinic-exports/${TENANT}/${EXPORT_ID}.zip`);
    const files = unzip(t.saved[0].bytes);
    expect([...files.keys()]).toEqual([
      ...EXPORT_CATALOG.map((c) => c.file),
      'LEEME.txt',
    ]);
    const patients = files.get('pacientes.csv')!;
    expect(patients.startsWith('﻿"Id","Código","Nombre"')).toBe(true);
    // Fórmula neutralizada.
    expect(patients).toContain(`"'=1+1"`);
    expect(patients.split('\r\n').filter(Boolean)).toHaveLength(4);
    expect(files.get('LEEME.txt')).toContain('pacientes.csv (3 filas)');
    const [done] = t.completed;
    expect(done.sizeBytes).toBe(t.saved[0].bytes.length);
    expect(done.rowCounts['pacientes.csv']).toBe(3);
    expect(done.fileCount).toBe(EXPORT_CATALOG.length);
    expect(done.downloadExpiresAt.toISOString()).toBe(
      '2026-11-22T13:00:00.000Z',
    );
  });

  it('streaming por páginas: nunca pide más de EXPORT_PAGE_SIZE filas y hace ceil(n/página)+1 consultas como mucho', async () => {
    const n = EXPORT_PAGE_SIZE * 2 + 500;
    const t = setup({ patients: n });
    await t.builder.build(EXPORT_ID, t.ctx);
    const patientCalls = t.pageCalls.filter((c) => c.file === 'pacientes.csv');
    expect(patientCalls).toHaveLength(Math.ceil(n / EXPORT_PAGE_SIZE));
    expect(patientCalls.every((c) => c.limit === EXPORT_PAGE_SIZE)).toBe(true);
    // Keyset: cada página empieza tras el último id de la anterior.
    expect(patientCalls[0].after).toBeNull();
    expect(patientCalls[1].after).toBe(
      `00000000-0000-4000-8000-${String(EXPORT_PAGE_SIZE - 1).padStart(12, '0')}`,
    );
    // Ficheros vacíos: una sola consulta.
    for (const table of EXPORT_CATALOG.filter(
      (c) => c.file !== 'pacientes.csv',
    )) {
      expect(t.pageCalls.filter((c) => c.file === table.file)).toHaveLength(1);
    }
    expect(t.completed[0].rowCounts['pacientes.csv']).toBe(n);
  });

  it('avisa a TODOS los ADMIN activos dentro de la transacción de READY y programa el borrado a los 7 días', async () => {
    const t = setup();
    await t.builder.build(EXPORT_ID, t.ctx);
    expect(t.txInserts).toEqual(['ana@clinica.test', 'luis@clinica.test']);
    expect(t.kicks).toEqual(['ana@clinica.test', 'luis@clinica.test']);
    const vars = t.prepareInTx.mock.calls[0][0] as unknown as {
      template: string;
      vars: Record<string, unknown>;
      enforceQuota: boolean;
    };
    expect(vars.template).toBe('clinic-export-ready');
    expect(vars.enforceQuota).toBe(false);
    expect(vars.vars).toMatchObject({
      clinicName: 'Clínica Ávila',
      requestedByName: 'Ana Rodríguez',
      settingsUrl: 'https://avila.dentalix.app/settings/exportar-datos',
    });
    // Ni enlace al fichero ni clave del almacén en el email.
    expect(JSON.stringify(vars.vars)).not.toContain('clinic-exports/');
    expect(t.enqueued).toEqual([
      {
        name: CLINIC_EXPORT_PURGE_JOB,
        runAt: new Date('2026-11-28T13:00:00Z'),
        key: `clinic-export-purge:${EXPORT_ID}`,
      },
    ]);
  });

  it('ya terminada (READY/FAILED): no hace nada', async () => {
    const t = setup({ started: false });
    await expect(t.builder.build(EXPORT_ID, t.ctx)).resolves.toBe('SKIPPED');
    expect(t.pageCalls).toHaveLength(0);
    expect(t.saved).toHaveLength(0);
  });

  it('un fallo antes del último intento se reintenta sin marcar FAILED; en el último queda FAILED', async () => {
    const t = setup();
    (t.storage.saveFile as jest.Mock).mockRejectedValue(new Error('S3 caído'));
    await expect(t.builder.build(EXPORT_ID, t.ctx)).rejects.toThrow('S3 caído');
    expect(t.failed).toEqual([]);
    await expect(
      t.builder.build(EXPORT_ID, { ...t.ctx, attempt: 3 }),
    ).rejects.toThrow('S3 caído');
    expect(t.failed).toEqual(['BUILD_FAILED']);
  });

  it('si falla tras subir el fichero, en el último intento lo borra del almacén', async () => {
    const t = setup();
    (t.repo.complete as jest.Mock).mockRejectedValue(new Error('BD caída'));
    await expect(
      t.builder.build(EXPORT_ID, { ...t.ctx, attempt: 3 }),
    ).rejects.toThrow('BD caída');
    expect(t.storageDelete).toHaveBeenCalledWith(
      `clinic-exports/${TENANT}/${EXPORT_ID}.zip`,
    );
  });

  it('demasiado grande: FAILED TOO_LARGE sin reintentar', async () => {
    const t = setup();
    (t.repo.page as jest.Mock).mockRejectedValue(new ZipTooLargeError());
    await expect(t.builder.build(EXPORT_ID, t.ctx)).resolves.toBe('TOO_LARGE');
    expect(t.failed).toEqual(['TOO_LARGE']);
  });

  it('con la reserva perdida no produce efectos', async () => {
    const t = setup();
    const abort = new AbortController();
    abort.abort();
    await expect(
      t.builder.build(EXPORT_ID, { ...t.ctx, signal: abort.signal }),
    ).rejects.toThrow('Intento abortado');
    expect(t.saved).toHaveLength(0);
    expect(t.completed).toHaveLength(0);
  });

  it('el borrado diferido quita el fichero y lo marca', async () => {
    const t = setup();
    await t.builder.purge(EXPORT_ID);
    expect(t.storageDelete).toHaveBeenCalledWith('clinic-exports/x/y.zip');
    expect(t.markFileDeleted).toHaveBeenCalledWith(EXPORT_ID, NOW);
  });
});
