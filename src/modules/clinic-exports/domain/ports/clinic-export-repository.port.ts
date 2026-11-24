import type { Prisma } from '@prisma/client';
import type { LocationRegionalSettings } from '../../../../shared/locations/location-regional';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type {
  ClinicExportErrorCode,
  ClinicExportRecord,
} from '../clinic-export';
import type { ExportRow } from '../csv-format';

export const CLINIC_EXPORT_REPOSITORY = Symbol('CLINIC_EXPORT_REPOSITORY');
export const CLINIC_EXPORT_CLOCK = Symbol('CLINIC_EXPORT_CLOCK');
export type ClinicExportClock = () => Date;

/** Algo que se escribe DENTRO de la transacción (el trabajo, los emails). */
export type InTx = (tx: Prisma.TransactionClient) => Promise<void>;

export type RequestOutcome =
  { kind: 'CREATED'; id: string } | { kind: 'IN_PROGRESS' };

export type DownloadOutcome =
  | {
      kind: 'OK';
      fileKey: string;
      sizeBytes: number;
      completedAt: Date;
    }
  | { kind: 'NOT_FOUND' | 'NOT_READY' | 'DOWNLOADED' | 'EXPIRED' | 'FAILED' };

export interface ClinicAdmin {
  userId: string;
  fullName: string;
  email: string;
}

export interface StartedExport {
  requestedById: string;
  requestedAt: Date;
}

export interface CompletedExport {
  fileKey: string;
  sizeBytes: number;
  fileCount: number;
  rowCounts: Record<string, number>;
  completedAt: Date;
  downloadExpiresAt: Date;
}

/**
 * Persistencia de las exportaciones (DX-053). Todo bajo la clínica del
 * contexto (RLS) y con `tenantId` explícito en cada consulta.
 */
export interface ClinicExportRepository {
  /** ¿`userId` es hoy ADMIN activo (membresía y usuario sin retirar)? */
  isActiveAdmin(userId: string): Promise<boolean>;

  /**
   * Da por muertas las en curso pedidas antes de `staleBefore` (FAILED
   * `STALE`) e inserta una PENDING con `afterInsert` (el trabajo) y su evento
   * de auditoría en la MISMA transacción. `IN_PROGRESS` si ya hay otra en
   * curso (índice único parcial: sin carreras).
   */
  request(
    ctx: AuditRequestContext,
    staleBefore: Date,
    /** `staleIds`: las que se acaban de cerrar como STALE (su fichero se purga). */
    afterInsert: (
      exportId: string,
      tx: Prisma.TransactionClient,
      staleIds: string[],
    ) => Promise<void>,
  ): Promise<RequestOutcome>;

  /** Historial, las más recientes primero. */
  list(limit: number): Promise<ClinicExportRecord[]>;

  /**
   * Consume el enlace de un solo uso (UPDATE condicional) y audita la
   * descarga (`EXPORT`) en la misma transacción.
   */
  consumeDownload(
    id: string,
    ctx: AuditRequestContext,
    now: Date,
  ): Promise<DownloadOutcome>;

  /** PENDING/RUNNING → RUNNING; null si ya terminó (READY/FAILED) o no existe. */
  start(id: string, now: Date): Promise<StartedExport | null>;

  /**
   * Antes de subir el ZIP: la fila RUNNING guarda su clave y `afterUpdate`
   * programa el borrado (misma transacción). false si ya no está RUNNING.
   */
  reserveFile(id: string, fileKey: string, afterUpdate: InTx): Promise<boolean>;

  /** RUNNING → READY con `afterUpdate` (emails, borrado diferido) en la misma transacción. */
  complete(
    id: string,
    data: CompletedExport,
    afterUpdate: InTx,
  ): Promise<boolean>;

  /** PENDING/RUNNING → FAILED con el código. */
  fail(id: string, code: ClinicExportErrorCode, now: Date): Promise<void>;

  /** Marca el fichero como borrado y devuelve su clave (null si no hay). */
  fileToPurge(id: string): Promise<string | null>;
  markFileDeleted(id: string, now: Date): Promise<void>;

  /** ADMIN activos de la clínica (destinatarios del aviso). */
  activeAdmins(): Promise<ClinicAdmin[]>;

  /** Nombre de la clínica y la región de su sede principal. */
  clinic(): Promise<{
    name: string;
    region: LocationRegionalSettings | null;
  } | null>;

  /** Una página del fichero `file` del catálogo (`pageQuery`). */
  page(
    file: string,
    afterId: string | null,
    limit: number,
  ): Promise<ExportRow[]>;
}
