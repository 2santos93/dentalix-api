import {
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import type { FileStoragePort } from '../../../shared/storage/file-storage.port';
import {
  CLINIC_EXPORT_ALREADY_DOWNLOADED_MESSAGE,
  CLINIC_EXPORT_BREAK_GLASS_MESSAGE,
  CLINIC_EXPORT_BUILD_JOB,
  CLINIC_EXPORT_PURGE_JOB,
  CLINIC_EXPORT_EXPIRED_MESSAGE,
  CLINIC_EXPORT_FORBIDDEN_MESSAGE,
  CLINIC_EXPORT_IN_PROGRESS_MESSAGE,
  type ClinicExportRecord,
} from '../domain/clinic-export';
import type {
  ClinicExportRepository,
  DownloadOutcome,
} from '../domain/ports/clinic-export-repository.port';
import type { ClinicExportJobQueue } from './clinic-export-builder';
import {
  ClinicExportsUseCases,
  type ClinicExportActor,
} from './clinic-exports.use-cases';

const NOW = new Date('2026-11-21T12:00:00Z');
const ID = '22222222-2222-4222-8222-222222222222';

const actor = (over: Partial<ClinicExportActor> = {}): ClinicExportActor => ({
  ctx: {
    tenantId: 't1',
    locationId: 'l1',
    actor: { userId: 'u1', role: 'ADMIN' },
    requestId: null,
    ip: null,
    userAgent: null,
  },
  breakGlass: false,
  restrictedToLocations: false,
  ...over,
});

const record: ClinicExportRecord = {
  id: ID,
  status: 'PENDING',
  requestedById: 'u1',
  requestedByName: 'Ana',
  requestedAt: NOW,
  startedAt: null,
  completedAt: null,
  errorCode: null,
  sizeBytes: null,
  fileCount: null,
  rowCounts: null,
  downloadExpiresAt: null,
  downloadedAt: null,
  downloadedByName: null,
  fileDeletedAt: null,
};

function setup(download: DownloadOutcome = { kind: 'NOT_FOUND' }) {
  const enqueued: { name: string; key?: string }[] = [];
  const consumeDownload = jest.fn(() => Promise.resolve(download));
  const request = jest.fn(
    async (
      _ctx: unknown,
      staleBefore: Date,
      after: (id: string, tx: never, staleIds: string[]) => Promise<void>,
    ) => {
      expect(staleBefore.toISOString()).toBe('2026-11-21T06:00:00.000Z');
      await after(ID, {} as never, ['stale-1']);
      return { kind: 'CREATED' as const, id: ID };
    },
  );
  const repo = {
    isActiveAdmin: jest.fn(() => Promise.resolve(true)),
    request,
    list: jest.fn(() => Promise.resolve([record])),
    consumeDownload,
  } as unknown as ClinicExportRepository;
  const queue: ClinicExportJobQueue = {
    enqueue: jest.fn((name, _p, opts) => {
      enqueued.push({ name, key: opts.idempotencyKey });
      return Promise.resolve({ id: 'j', created: true });
    }),
  };
  const getSignedUrl = jest.fn(() =>
    Promise.resolve('https://almacen/firmada'),
  );
  const storage = { getSignedUrl } as unknown as FileStoragePort;
  const useCases = new ClinicExportsUseCases(repo, queue, storage, () => NOW);
  return { useCases, repo, enqueued, getSignedUrl, request, consumeDownload };
}

describe('ClinicExportsUseCases (DX-053)', () => {
  it('pedir: encola el trabajo en la transacción de la fila y devuelve PENDING', async () => {
    const t = setup();
    await expect(t.useCases.request(actor())).resolves.toMatchObject({
      id: ID,
      state: 'PENDING',
      canDownload: false,
    });
    expect(t.enqueued).toEqual([
      { name: CLINIC_EXPORT_BUILD_JOB, key: `clinic-export:${ID}` },
      // La colgada que se cerró como STALE: su fichero se purga ya.
      {
        name: CLINIC_EXPORT_PURGE_JOB,
        key: 'clinic-export-purge-stale:stale-1',
      },
    ]);
  });

  it('otra en curso: 409 en español', async () => {
    const t = setup();
    (t.repo.request as jest.Mock).mockResolvedValue({ kind: 'IN_PROGRESS' });
    await expect(t.useCases.request(actor())).rejects.toThrow(
      new ConflictException(CLINIC_EXPORT_IN_PROGRESS_MESSAGE),
    );
  });

  it('acceso de soporte, token con sedes o miembro que ya no es ADMIN: 403 sin tocar nada', async () => {
    const t = setup();
    await expect(
      t.useCases.request(actor({ breakGlass: true })),
    ).rejects.toThrow(
      new ForbiddenException(CLINIC_EXPORT_BREAK_GLASS_MESSAGE),
    );
    await expect(
      t.useCases.list(actor({ restrictedToLocations: true })),
    ).rejects.toThrow(new ForbiddenException(CLINIC_EXPORT_FORBIDDEN_MESSAGE));
    (t.repo.isActiveAdmin as jest.Mock).mockResolvedValue(false);
    await expect(t.useCases.download(ID, actor())).rejects.toThrow(
      new ForbiddenException(CLINIC_EXPORT_FORBIDDEN_MESSAGE),
    );
    expect(t.request).not.toHaveBeenCalled();
    expect(t.consumeDownload).not.toHaveBeenCalled();
  });

  it('descargar: URL firmada de 60 s como adjunto ZIP', async () => {
    const t = setup({
      kind: 'OK',
      fileKey: 'clinic-exports/t1/x.zip',
      sizeBytes: 1234,
      completedAt: NOW,
    });
    await expect(t.useCases.download(ID, actor())).resolves.toEqual({
      url: 'https://almacen/firmada',
      expiresInSeconds: 60,
      fileName: 'exportacion-dentalix-2026-11-21.zip',
      sizeBytes: 1234,
    });
    expect(t.getSignedUrl).toHaveBeenCalledWith('clinic-exports/t1/x.zip', 60, {
      disposition: 'attachment',
      filename: 'exportacion-dentalix-2026-11-21.zip',
      contentType: 'application/zip',
    });
  });

  it.each([
    ['NOT_FOUND', NotFoundException],
    ['NOT_READY', ConflictException],
    ['FAILED', ConflictException],
    ['DOWNLOADED', GoneException],
    ['EXPIRED', GoneException],
  ] as const)('descargar %s → %p', async (kind, error) => {
    const t = setup({ kind });
    await expect(t.useCases.download(ID, actor())).rejects.toBeInstanceOf(
      error,
    );
    expect(t.getSignedUrl).not.toHaveBeenCalled();
  });

  it('mensajes de 410 en español', async () => {
    await expect(
      setup({ kind: 'DOWNLOADED' }).useCases.download(ID, actor()),
    ).rejects.toThrow(CLINIC_EXPORT_ALREADY_DOWNLOADED_MESSAGE);
    await expect(
      setup({ kind: 'EXPIRED' }).useCases.download(ID, actor()),
    ).rejects.toThrow(CLINIC_EXPORT_EXPIRED_MESSAGE);
  });
});
