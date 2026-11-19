import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { requireLocationFormat } from '../../../shared/locations/location-regional';
import { fromCents } from '../../../shared/money/money';
import { readImportFile } from '../../patient-imports/domain/read-import-file';
import { ImportFileError } from '../../patient-imports/domain/tabular-file';
import {
  StatementMappingError,
  readStoredMapping,
  suggestMapping,
  validateMapping,
  type StatementColumnMapping,
} from '../domain/statement-mapping';
import {
  parseStatement,
  periodOf,
  withNaturalKeys,
  type StatementIssue,
} from '../domain/statement-parsing';
import {
  BankAccountNotFoundError,
  BankMatchNotFoundError,
  BankMovementNotFoundError,
  BankPaymentNotFoundError,
  BankReconciliationConflict,
  PrismaBankReconciliationRepository,
  type AccountInput,
  type BankAccountView,
  type BankImportView,
  type CandidatesView,
  type ConfirmImportResult,
  type PeriodPage,
  type PeriodSummary,
  type ReconciliationStatus,
} from '../infrastructure/prisma-bank-reconciliation.repository';

export interface StatementUpload {
  originalname: string;
  size: number;
  buffer: Buffer;
}

export const MISSING_STATEMENT_MESSAGE = 'Sube el extracto (CSV o Excel).';
export const ACCOUNT_NOT_FOUND_MESSAGE = 'No existe esa cuenta.';
export const MOVEMENT_NOT_FOUND_MESSAGE = 'No existe ese movimiento.';
export const MATCH_NOT_FOUND_MESSAGE = 'No existe ese emparejado.';
export const PAYMENT_NOT_FOUND_MESSAGE = 'No existe ese abono o está anulado.';
export const STATEMENT_CHANGED_MESSAGE =
  'El archivo no es el de la vista previa: vuelve a revisarlo antes de importar.';
/** Un período de las listas: como mucho ~3 meses de extracto. */
export const MAX_PERIOD_DAYS = 93;
const SAMPLE_ROWS = 5;
const PREVIEW_ROWS = 10;

export interface InspectStatementResult {
  fileSha256: string;
  fileFormat: 'CSV' | 'XLSX';
  headers: string[];
  suggestedMapping: Partial<StatementColumnMapping>;
  /** El mapeo propuesto es el guardado en la cuenta. */
  usesSavedMapping: boolean;
  sampleRows: string[][];
  totalRows: number;
}

export interface PreviewStatementResult {
  fileSha256: string;
  fileFormat: 'CSV' | 'XLSX';
  totalRows: number;
  creditRows: number;
  newRows: number;
  duplicateRows: number;
  ignoredRows: number;
  errorRows: number;
  periodFrom: string | null;
  periodTo: string | null;
  issues: StatementIssue[];
  rows: {
    rowNumber: number;
    bookedOn: string;
    reference: string | null;
    amount: number;
    description: string | null;
    duplicate: boolean;
  }[];
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireFile(file: StatementUpload | undefined): StatementUpload {
  if (!file || !file.buffer)
    throw new BadRequestException(MISSING_STATEMENT_MESSAGE);
  return file;
}

/** Los errores del repositorio, en HTTP con el mensaje en español. */
function httpOf(error: unknown): unknown {
  if (error instanceof BankAccountNotFoundError)
    return new NotFoundException(ACCOUNT_NOT_FOUND_MESSAGE);
  if (error instanceof BankMovementNotFoundError)
    return new NotFoundException(MOVEMENT_NOT_FOUND_MESSAGE);
  if (error instanceof BankMatchNotFoundError)
    return new NotFoundException(MATCH_NOT_FOUND_MESSAGE);
  if (error instanceof BankPaymentNotFoundError)
    return new NotFoundException(PAYMENT_NOT_FOUND_MESSAGE);
  if (error instanceof BankReconciliationConflict) {
    return new ConflictException({
      statusCode: 409,
      code: error.code,
      message: error.message,
    });
  }
  if (error instanceof StatementMappingError)
    return new BadRequestException(error.message);
  return error;
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw httpOf(error);
  }
}

/** `from`..`to` válidos (AAAA-MM-DD, en orden y ≤ 93 días). */
export function assertPeriod(from: string, to: string): void {
  if (from > to) {
    throw new BadRequestException(
      'La fecha «desde» no puede ser posterior a «hasta».',
    );
  }
  const days =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
    86_400_000;
  if (days > MAX_PERIOD_DAYS) {
    throw new BadRequestException(
      `Elige un período de ${MAX_PERIOD_DAYS} días como mucho.`,
    );
  }
}

/**
 * Casos de uso de la conciliación bancaria (DX-571). Solo ADMIN (controlador).
 * El extracto no se guarda: se lee del temporal de multer (que se borra al
 * terminar) y de cada fila de ENTRADA solo quedan fecha, referencia, importe
 * y descripción truncada.
 */
@Injectable()
export class BankReconciliationService {
  constructor(private readonly repo: PrismaBankReconciliationRepository) {}

  listAccounts(): Promise<BankAccountView[]> {
    return guard(() => this.repo.listAccounts());
  }

  createAccount(input: AccountInput, userId: string): Promise<BankAccountView> {
    return guard(() => this.repo.createAccount(input, userId));
  }

  updateAccount(
    id: string,
    patch: Partial<AccountInput> & { active?: boolean },
  ): Promise<BankAccountView> {
    return guard(() => this.repo.updateAccount(id, patch));
  }

  listImports(accountId: string): Promise<BankImportView[]> {
    return guard(() => this.repo.listImports(accountId));
  }

  /** El fichero leído con el lector de DX-107 (topes SEC-046 incluidos). */
  private async read(file: StatementUpload) {
    try {
      return await readImportFile(file.buffer, file.originalname);
    } catch (error) {
      if (!(error instanceof ImportFileError)) throw error;
      const location = await this.repo.formatLocation();
      throw new BadRequestException(
        error.render(() => requireLocationFormat(location)),
      );
    }
  }

  inspect(
    accountId: string,
    upload: StatementUpload | undefined,
  ): Promise<InspectStatementResult> {
    return guard(async () => {
      const file = requireFile(upload);
      const account = await this.repo.findAccount(accountId);
      const parsed = await this.read(file);
      const stored = readStoredMapping(account.columnMapping);
      const suggested = suggestMapping(parsed.table.headers, stored);
      return {
        fileSha256: sha256(file.buffer),
        fileFormat: parsed.format,
        headers: parsed.table.headers,
        suggestedMapping: suggested,
        usesSavedMapping:
          stored !== null &&
          suggested.date === stored.date &&
          suggested.reference === stored.reference,
        sampleRows: parsed.table.rows.slice(0, SAMPLE_ROWS).map((r) => r.cells),
        totalRows: parsed.table.rows.length,
      };
    });
  }

  private async parse(file: StatementUpload, rawMapping: unknown) {
    const parsed = await this.read(file);
    const mapping = validateMapping(rawMapping, parsed.table.headers);
    const statement = parseStatement(parsed.table, mapping, parsed.format);
    return {
      format: parsed.format,
      mapping,
      statement,
      credits: withNaturalKeys(statement.credits),
    };
  }

  preview(
    accountId: string,
    upload: StatementUpload | undefined,
    rawMapping: unknown,
  ): Promise<PreviewStatementResult> {
    return guard(async () => {
      const file = requireFile(upload);
      await this.repo.findAccount(accountId);
      const { format, statement, credits } = await this.parse(file, rawMapping);
      const existing = await this.repo.existingKeys(
        accountId,
        credits.map((c) => c.naturalKey),
      );
      const period = periodOf(credits);
      return {
        fileSha256: sha256(file.buffer),
        fileFormat: format,
        totalRows: statement.totalRows,
        creditRows: credits.length,
        newRows: credits.filter((c) => !existing.has(c.naturalKey)).length,
        duplicateRows: credits.filter((c) => existing.has(c.naturalKey)).length,
        ignoredRows: statement.ignoredRows,
        errorRows: statement.errorRows,
        periodFrom: period?.from ?? null,
        periodTo: period?.to ?? null,
        issues: statement.issues,
        rows: credits.slice(0, PREVIEW_ROWS).map((c) => ({
          rowNumber: c.rowNumber,
          bookedOn: c.bookedOn,
          reference: c.reference,
          amount: fromCents(c.amountCents),
          description: c.description,
          duplicate: existing.has(c.naturalKey),
        })),
      };
    });
  }

  confirm(
    accountId: string,
    upload: StatementUpload | undefined,
    rawMapping: unknown,
    expectedSha256: string,
    userId: string,
  ): Promise<ConfirmImportResult> {
    return guard(async () => {
      const file = requireFile(upload);
      const fileSha256 = sha256(file.buffer);
      if (fileSha256 !== expectedSha256.toLowerCase()) {
        throw new ConflictException({
          statusCode: 409,
          code: 'BANK_STATEMENT_CHANGED',
          message: STATEMENT_CHANGED_MESSAGE,
        });
      }
      await this.repo.findAccount(accountId);
      const { format, mapping, statement, credits } = await this.parse(
        file,
        rawMapping,
      );
      return this.repo.confirmImport({
        accountId,
        fileSha256,
        fileFormat: format,
        totalRows: statement.totalRows,
        ignoredRows: statement.ignoredRows,
        errorRows: statement.errorRows,
        credits,
        mapping,
        userId,
      });
    });
  }

  summary(accountId: string, from: string, to: string): Promise<PeriodSummary> {
    assertPeriod(from, to);
    return guard(() => this.repo.periodSummary(accountId, from, to));
  }

  items(
    accountId: string,
    from: string,
    to: string,
    status: ReconciliationStatus,
    page: number,
    pageSize: number,
  ): Promise<PeriodPage> {
    assertPeriod(from, to);
    return guard(() =>
      this.repo.periodPage(accountId, from, to, status, page, pageSize),
    );
  }

  autoMatch(
    accountId: string,
    from: string,
    to: string,
    userId: string,
  ): Promise<{ id: string; matched: number }> {
    assertPeriod(from, to);
    return guard(async () => ({
      id: accountId,
      matched: await this.repo.autoMatchPeriod(accountId, from, to, userId),
    }));
  }

  candidates(movementId: string): Promise<CandidatesView> {
    return guard(() => this.repo.candidates(movementId));
  }

  match(movementId: string, paymentId: string, userId: string) {
    return guard(() => this.repo.manualMatch(movementId, paymentId, userId));
  }

  unmatch(matchId: string, userId: string): Promise<{ id: string }> {
    return guard(() => this.repo.unmatch(matchId, userId));
  }
}
