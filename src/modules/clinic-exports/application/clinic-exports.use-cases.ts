import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FILE_STORAGE } from '../../../shared/storage/file-storage.port';
import type { FileStoragePort } from '../../../shared/storage/file-storage.port';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  CLINIC_EXPORT_ALREADY_DOWNLOADED_MESSAGE,
  CLINIC_EXPORT_BREAK_GLASS_MESSAGE,
  CLINIC_EXPORT_BUILD_JOB,
  CLINIC_EXPORT_EXPIRED_MESSAGE,
  CLINIC_EXPORT_FAILED_MESSAGE,
  CLINIC_EXPORT_FORBIDDEN_MESSAGE,
  CLINIC_EXPORT_IN_PROGRESS_MESSAGE,
  CLINIC_EXPORT_NOT_FOUND_MESSAGE,
  CLINIC_EXPORT_NOT_READY_MESSAGE,
  HISTORY_LIMIT,
  SIGNED_URL_TTL_SECONDS,
  STALE_AFTER_HOURS,
  exportFileName,
  viewOf,
  type ClinicExportView,
} from '../domain/clinic-export';
import {
  CLINIC_EXPORT_CLOCK,
  CLINIC_EXPORT_REPOSITORY,
  type ClinicExportClock,
  type ClinicExportRepository,
} from '../domain/ports/clinic-export-repository.port';
import {
  CLINIC_EXPORT_JOB_QUEUE,
  type ClinicExportJobQueue,
} from './clinic-export-builder';

/** Quién pide: el contexto de auditoría y lo que el token dice de él. */
export interface ClinicExportActor {
  ctx: AuditRequestContext;
  /** Acceso de soporte (SEC-008): nunca exporta. */
  breakGlass: boolean;
  /** DX-089: un token con sedes restringidas (un ADMIN no debería llevarlo). */
  restrictedToLocations: boolean;
}

export interface ClinicExportDownload {
  url: string;
  expiresInSeconds: number;
  fileName: string;
  sizeBytes: number;
}

const HOUR_MS = 3_600_000;

/**
 * DX-053: pedir, listar y descargar la exportación de los datos de la
 * clínica. Solo ADMIN (RolesGuard) y, además, miembro ADMIN ACTIVO de verdad:
 * ni el acceso de soporte ni un token con sedes restringidas.
 */
@Injectable()
export class ClinicExportsUseCases {
  constructor(
    @Inject(CLINIC_EXPORT_REPOSITORY)
    private readonly repo: ClinicExportRepository,
    @Inject(CLINIC_EXPORT_JOB_QUEUE)
    private readonly queue: ClinicExportJobQueue,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
    @Inject(CLINIC_EXPORT_CLOCK) private readonly clock: ClinicExportClock,
  ) {}

  private async assertAdmin(actor: ClinicExportActor): Promise<void> {
    if (actor.breakGlass) {
      throw new ForbiddenException(CLINIC_EXPORT_BREAK_GLASS_MESSAGE);
    }
    if (
      actor.restrictedToLocations ||
      !(await this.repo.isActiveAdmin(actor.ctx.actor.userId))
    ) {
      throw new ForbiddenException(CLINIC_EXPORT_FORBIDDEN_MESSAGE);
    }
  }

  async request(actor: ClinicExportActor): Promise<ClinicExportView> {
    await this.assertAdmin(actor);
    const now = this.clock();
    const outcome = await this.repo.request(
      actor.ctx,
      new Date(now.getTime() - STALE_AFTER_HOURS * HOUR_MS),
      async (exportId, tx) => {
        await this.queue.enqueue(
          CLINIC_EXPORT_BUILD_JOB,
          { exportId },
          { tx, idempotencyKey: `clinic-export:${exportId}` },
        );
      },
    );
    if (outcome.kind === 'IN_PROGRESS') {
      throw new ConflictException(CLINIC_EXPORT_IN_PROGRESS_MESSAGE);
    }
    const created = (await this.repo.list(HISTORY_LIMIT)).find(
      (r) => r.id === outcome.id,
    );
    if (!created) throw new Error('Exportación recién creada no encontrada');
    return viewOf(created, now);
  }

  async list(actor: ClinicExportActor): Promise<ClinicExportView[]> {
    await this.assertAdmin(actor);
    const now = this.clock();
    return (await this.repo.list(HISTORY_LIMIT)).map((r) => viewOf(r, now));
  }

  async download(
    id: string,
    actor: ClinicExportActor,
  ): Promise<ClinicExportDownload> {
    await this.assertAdmin(actor);
    const outcome = await this.repo.consumeDownload(
      id,
      actor.ctx,
      this.clock(),
    );
    switch (outcome.kind) {
      case 'NOT_FOUND':
        throw new NotFoundException(CLINIC_EXPORT_NOT_FOUND_MESSAGE);
      case 'NOT_READY':
        throw new ConflictException(CLINIC_EXPORT_NOT_READY_MESSAGE);
      case 'FAILED':
        throw new ConflictException(CLINIC_EXPORT_FAILED_MESSAGE);
      case 'DOWNLOADED':
        throw new GoneException(CLINIC_EXPORT_ALREADY_DOWNLOADED_MESSAGE);
      case 'EXPIRED':
        throw new GoneException(CLINIC_EXPORT_EXPIRED_MESSAGE);
      case 'OK': {
        const fileName = exportFileName(outcome.completedAt);
        const url = await this.storage.getSignedUrl(
          outcome.fileKey,
          SIGNED_URL_TTL_SECONDS,
          {
            disposition: 'attachment',
            filename: fileName,
            contentType: 'application/zip',
          },
        );
        return {
          url,
          expiresInSeconds: SIGNED_URL_TTL_SECONDS,
          fileName,
          sizeBytes: outcome.sizeBytes,
        };
      }
    }
  }
}
