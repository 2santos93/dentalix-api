import { Inject, Injectable, Logger } from '@nestjs/common';
import { createWriteStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { finished } from 'node:stream/promises';
import { CSV_BOM } from '../../../shared/csv/csv-cells';
import { regionalFormat } from '../../../shared/format/regional-format';
import { removeLocalFile } from '../../../shared/storage/local-file';
import { FILE_STORAGE } from '../../../shared/storage/file-storage.port';
import type { FileStoragePort } from '../../../shared/storage/file-storage.port';
import { TenantLinkBaseService } from '../../../shared/tenancy/tenant-link-base.service';
import { ZipTooLargeError, ZipWriter } from '../../../shared/zip/zip-writer';
import type { EnqueueOptions, EnqueueResult } from '../../jobs/domain/job';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import type { PreparedEmail } from '../../notifications/email/application/email-outbox.service';
import {
  CLINIC_EXPORT_PURGE_JOB,
  CLINIC_EXPORT_SETTINGS_PATH,
  DOWNLOAD_WINDOW_HOURS,
  EXPORT_PAGE_SIZE,
  FILE_RETENTION_DAYS,
  exportFileKey,
  sizeLabel,
} from '../domain/clinic-export';
import { csvHeader, csvLine } from '../domain/csv-format';
import { EXPORT_CATALOG } from '../domain/export-catalog';
import { exportReadme } from '../domain/export-readme';
import {
  CLINIC_EXPORT_CLOCK,
  CLINIC_EXPORT_REPOSITORY,
  type ClinicExportClock,
  type ClinicExportRepository,
} from '../domain/ports/clinic-export-repository.port';

/** Temporal del ZIP mientras se genera (se borra siempre al terminar). */
export const EXPORT_TEMP_DIR = path.join(tmpdir(), 'dentalix-exports');

/** Lo que el generador necesita de la cola (DX-085). */
export const CLINIC_EXPORT_JOB_QUEUE = Symbol('CLINIC_EXPORT_JOB_QUEUE');
export interface ClinicExportJobQueue {
  enqueue(
    name: string,
    payload: { exportId: string },
    options: EnqueueOptions,
  ): Promise<EnqueueResult>;
}

export interface BuildContext {
  tenantId: string;
  attempt: number;
  maxAttempts: number;
  signal?: AbortSignal;
}

export type BuildOutcome = 'READY' | 'SKIPPED' | 'TOO_LARGE';

/** El worker perdió la reserva del trabajo (o se apaga): sin efectos. */
function assertLeaseHeld(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Intento abortado');
}

const HOUR_MS = 3_600_000;

/**
 * DX-053: genera el ZIP de UNA exportación (la del trabajo, bajo su clínica).
 * Recorre el catálogo fichero a fichero en páginas de `EXPORT_PAGE_SIZE`
 * filas (keyset, una transacción corta por página) y escribe cada CSV
 * comprimido en streaming a un temporal: en memoria solo hay una página.
 * Sube el ZIP al almacén y, en UNA transacción, lo marca READY, encola el
 * aviso a todos los ADMIN y el borrado del fichero a los 7 días.
 *
 * Idempotente: si la exportación ya terminó (READY o FAILED) no hace nada; un
 * reintento la vuelve a generar desde cero con la misma clave del almacén.
 */
@Injectable()
export class ClinicExportBuilder {
  private readonly logger = new Logger('ClinicExport');

  constructor(
    @Inject(CLINIC_EXPORT_REPOSITORY)
    private readonly repo: ClinicExportRepository,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
    @Inject(CLINIC_EXPORT_JOB_QUEUE)
    private readonly queue: ClinicExportJobQueue,
    private readonly email: EmailOutbox,
    private readonly links: TenantLinkBaseService,
    @Inject(CLINIC_EXPORT_CLOCK) private readonly clock: ClinicExportClock,
  ) {}

  async build(exportId: string, context: BuildContext): Promise<BuildOutcome> {
    const startedAt = this.clock();
    const started = await this.repo.start(exportId, startedAt);
    if (!started) return 'SKIPPED';
    const tempFile = path.join(
      EXPORT_TEMP_DIR,
      `${exportId}-${context.attempt}.zip`,
    );
    const fileKey = exportFileKey(context.tenantId, exportId);
    let uploaded = false;
    let completed = false;
    try {
      const { sizeBytes, rowCounts } = await this.writeZip(
        tempFile,
        startedAt,
        context.signal,
      );
      assertLeaseHeld(context.signal);
      // Red de seguridad ANTES de subir: la fila ya nombra la clave y el
      // borrado a los 7 días queda programado (outbox). Aunque el proceso
      // muera entre la subida y READY, el trabajo de borrado encuentra el
      // fichero y lo quita: nunca queda un volcado sin dueño.
      const reserved = await this.repo.reserveFile(exportId, fileKey, (tx) =>
        this.queue
          .enqueue(
            CLINIC_EXPORT_PURGE_JOB,
            { exportId },
            {
              tx,
              runAt: new Date(
                this.clock().getTime() + FILE_RETENTION_DAYS * 24 * HOUR_MS,
              ),
              idempotencyKey: `clinic-export-purge:${exportId}`,
            },
          )
          .then(() => undefined),
      );
      if (!reserved) return 'SKIPPED';
      assertLeaseHeld(context.signal);
      uploaded = true;
      await this.storage.saveFile(fileKey, tempFile, 'application/zip');

      const completedAt = this.clock();
      const downloadExpiresAt = new Date(
        completedAt.getTime() + DOWNLOAD_WINDOW_HOURS * HOUR_MS,
      );
      const emails = await this.prepareEmails(context.tenantId, {
        requestedById: started.requestedById,
        requestedAt: started.requestedAt,
        sizeBytes,
        downloadExpiresAt,
      });
      assertLeaseHeld(context.signal);
      completed = await this.repo.complete(
        exportId,
        {
          fileKey,
          sizeBytes,
          fileCount: Object.keys(rowCounts).length,
          rowCounts,
          completedAt,
          downloadExpiresAt,
        },
        async (tx) => {
          for (const email of emails) await email.insert(tx);
        },
      );
      if (!completed) return 'SKIPPED';
      for (const email of emails) email.kick();
      this.logger.log({
        event: 'clinic_export.ready',
        tenantId: context.tenantId,
        exportId,
        sizeBytes,
        files: Object.keys(rowCounts).length,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      });
      return 'READY';
    } catch (error) {
      const tooLarge = error instanceof ZipTooLargeError;
      if (tooLarge || context.attempt >= context.maxAttempts) {
        await this.repo.fail(
          exportId,
          tooLarge ? 'TOO_LARGE' : 'BUILD_FAILED',
          this.clock(),
        );
        this.logger.warn({
          event: 'clinic_export.failed',
          tenantId: context.tenantId,
          exportId,
          error: error instanceof Error ? error.name : 'Error',
        });
        // Demasiado grande no mejora reintentando.
        if (tooLarge) return 'TOO_LARGE';
      }
      throw error;
    } finally {
      await removeLocalFile(tempFile);
      // Subido (o a medio subir) y sin READY, salga por donde salga (error,
      // reserva perdida, `complete` que no cambió nada): fuera del almacén ya.
      // Un reintento lo vuelve a subir. Nunca tapa el error original.
      if (uploaded && !completed) await this.discardUpload(exportId, fileKey);
    }
  }

  /** Borra el ZIP no completado; si falla, queda el borrado programado. */
  private async discardUpload(
    exportId: string,
    fileKey: string,
  ): Promise<void> {
    try {
      // eslint-disable-next-line no-restricted-syntax -- DX-053: objeto del almacén (el ZIP huérfano), no una fila de la BD.
      await this.storage.delete(fileKey);
    } catch {
      this.logger.warn({
        event: 'clinic_export.orphan_delete_failed',
        exportId,
      });
    }
  }

  /** Escribe el ZIP en `file` y devuelve su tamaño y las filas por fichero. */
  async writeZip(
    file: string,
    startedAt: Date,
    signal?: AbortSignal,
  ): Promise<{ sizeBytes: number; rowCounts: Record<string, number> }> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const out = createWriteStream(file, { mode: 0o600 });
    const zip = new ZipWriter(out);
    const rowCounts: Record<string, number> = {};
    try {
      for (const table of EXPORT_CATALOG) {
        const counter = { rows: 0 };
        await zip.addFile(
          table.file,
          this.csvLines(table.file, counter, signal),
          startedAt,
        );
        rowCounts[table.file] = counter.rows;
      }
      await zip.addFile(
        'LEEME.txt',
        [exportReadme({ startedAt, finishedAt: this.clock(), rowCounts })],
        startedAt,
      );
      const sizeBytes = await zip.finish();
      out.end();
      await finished(out);
      return { sizeBytes, rowCounts };
    } catch (error) {
      out.destroy();
      throw error;
    }
  }

  /** Las líneas de un CSV, página a página (nunca el fichero entero). */
  private async *csvLines(
    file: string,
    counter: { rows: number },
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const table = EXPORT_CATALOG.find((t) => t.file === file);
    if (!table) throw new Error(`Fichero de exportación desconocido: ${file}`);
    yield `${CSV_BOM}${csvHeader(table.columns)}\r\n`;
    let after: string | null = null;
    for (;;) {
      assertLeaseHeld(signal);
      const rows = await this.repo.page(file, after, EXPORT_PAGE_SIZE);
      if (rows.length === 0) return;
      let chunk = '';
      for (const row of rows) chunk += `${csvLine(table.columns, row)}\r\n`;
      counter.rows += rows.length;
      yield chunk;
      if (rows.length < EXPORT_PAGE_SIZE) return;
      after = String(rows[rows.length - 1].k);
    }
  }

  /**
   * El aviso a cada ADMIN activo, preparado FUERA de la transacción (marca y
   * render) e insertado dentro (`complete`). Sin tope: es también un aviso
   * de seguridad (un volcado de datos de salud) y no se calla.
   */
  private async prepareEmails(
    tenantId: string,
    input: {
      requestedById: string;
      requestedAt: Date;
      sizeBytes: number;
      downloadExpiresAt: Date;
    },
  ): Promise<PreparedEmail[]> {
    const [admins, clinic, base] = await Promise.all([
      this.repo.activeAdmins(),
      this.repo.clinic(),
      this.links.forTenant(tenantId),
    ]);
    if (!clinic) return [];
    const fmt = clinic.region ? regionalFormat(clinic.region) : null;
    const label = (at: Date) =>
      fmt && clinic.region
        ? fmt.longDateTime(at, clinic.region.timeZone)
        : null;
    const requester = admins.find((a) => a.userId === input.requestedById);
    const vars = {
      clinicName: clinic.name,
      requestedByName: requester?.fullName ?? null,
      requestedAtLabel: label(input.requestedAt),
      expiresAtLabel: label(input.downloadExpiresAt),
      sizeLabel: sizeLabel(input.sizeBytes),
      settingsUrl: base ? `${base}${CLINIC_EXPORT_SETTINGS_PATH}` : null,
    };
    return Promise.all(
      admins.map((admin) =>
        this.email.prepareInTx({
          tenantId,
          to: admin.email,
          template: 'clinic-export-ready',
          referenceId: admin.userId,
          enforceQuota: false,
          vars,
        }),
      ),
    );
  }

  /** Borrado del fichero a los 7 días (idempotente). */
  async purge(exportId: string): Promise<void> {
    const key = await this.repo.fileToPurge(exportId);
    // eslint-disable-next-line no-restricted-syntax -- DX-053: el ZIP del almacén a los 7 días; la fila se conserva con fileDeletedAt.
    if (key) await this.storage.delete(key);
    await this.repo.markFileDeleted(exportId, this.clock());
  }
}
