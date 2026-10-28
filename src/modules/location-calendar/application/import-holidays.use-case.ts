import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { requireLocationFormat } from '../../../shared/locations/location-regional';
import { ImportFileError } from '../../patient-imports/domain/tabular-file';
import { parseCsvHolidays } from '../domain/csv-holidays';
import type {
  HolidayFileFormat,
  ParsedHolidayFile,
} from '../domain/holiday-file';
import {
  HOLIDAY_MESSAGES,
  classifyHolidayBatch,
  exceedsLocationLimit,
  type ClassifiedRow,
} from '../domain/holiday-rules';
import { parseIcsHolidays } from '../domain/ics-holidays';
import { holidayLimitReached } from '../domain/location-calendar-errors';
import {
  LOCATION_CALENDAR_REPOSITORY,
  type LocationCalendarRepository,
  type LocationFormatSource,
} from '../domain/ports/location-calendar-repository.port';

/** El fichero que multer dejó en el temporal (lo borra `UploadSlotInterceptor`). */
export interface UploadedFile {
  originalname: string;
  path: string;
}

export interface HolidayImportResult {
  format: HolidayFileFormat;
  dryRun: boolean;
  /** `new` = creados (o que se crearían en la vista previa). */
  counts: { new: number; duplicate: number; error: number };
  rows: ClassifiedRow[];
}

const EXTENSIONS: Record<string, HolidayFileFormat> = {
  '.csv': 'CSV',
  '.ics': 'ICS',
};

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
/** Un ICS empieza (tras BOM y blancos) por `BEGIN:VCALENDAR` (§5.1). */
const ICS_START = /^[ \t\r\n]*BEGIN:VCALENDAR/i;

/** Sin contenido: 0 bytes, o solo BOM y blancos. */
function isBlank(bytes: Buffer): boolean {
  const body = bytes.subarray(bytes.subarray(0, 3).equals(UTF8_BOM) ? 3 : 0);
  return /^[ \t\r\n]*$/.test(body.toString('latin1'));
}

function looksLikeIcs(bytes: Buffer): boolean {
  const head = bytes.subarray(
    bytes.subarray(0, 3).equals(UTF8_BOM) ? 3 : 0,
    // Los blancos de delante y la marca caben de sobra.
    4096,
  );
  return ICS_START.test(head.toString('latin1'));
}

/**
 * Importa festivos a una sede desde un CSV o un ICS (DX-316, spec §5.1).
 * Orden: la sede (otra clínica recibe 404 antes que cualquier error del
 * fichero), el fichero (falta, extensión, vacío, contenido), la lectura y la
 * clasificación como conjunto. La vista previa no
 * escribe ni bloquea; importar reclasifica y escribe las NEW bajo el bloqueo
 * del calendario. Los mensajes con cifras piden el formato de la sede solo al
 * pintarse (P4, G1-B I4).
 */
@Injectable()
export class ImportHolidaysUseCase {
  constructor(
    @Inject(LOCATION_CALENDAR_REPOSITORY)
    private readonly repo: LocationCalendarRepository,
  ) {}

  async execute(
    locationId: string,
    file: UploadedFile | undefined,
    opts: { dryRun: boolean },
  ): Promise<HolidayImportResult> {
    const { location, holidays } = await this.repo.readForImport(locationId);
    const parsed = await readHolidayFile(file, location);
    let rows: ClassifiedRow[];
    if (opts.dryRun) {
      rows = classifyHolidayBatch(parsed, holidays);
      // La vista previa avisa del tope igual que importar: lo que enseña es
      // lo que pasaría al confirmar.
      if (exceedsLocationLimit(holidays.length, rows)) {
        throw holidayLimitReached(requireLocationFormat(location));
      }
    } else {
      rows = await this.repo.importHolidays(locationId, parsed);
    }
    return {
      format: parsed.format,
      dryRun: opts.dryRun,
      counts: countRows(rows),
      rows,
    };
  }
}

async function readHolidayFile(
  file: UploadedFile | undefined,
  location: LocationFormatSource,
): Promise<ParsedHolidayFile> {
  if (!file) throw new BadRequestException(HOLIDAY_MESSAGES.missingFile);
  const extension = extname(file.originalname).toLowerCase();
  const format = EXTENSIONS[extension];
  if (!format) throw new BadRequestException(HOLIDAY_MESSAGES.wrongExtension);
  const bytes = await readFile(file.path);
  if (isBlank(bytes)) throw new BadRequestException(HOLIDAY_MESSAGES.emptyFile);
  if (looksLikeIcs(bytes) !== (format === 'ICS')) {
    throw new BadRequestException(
      HOLIDAY_MESSAGES.extensionMismatch(extension.slice(1)),
    );
  }
  try {
    return format === 'ICS' ? parseIcsHolidays(bytes) : parseCsvHolidays(bytes);
  } catch (error) {
    if (!(error instanceof ImportFileError)) throw error;
    throw new BadRequestException(
      error.render(() => requireLocationFormat(location)),
    );
  }
}

function countRows(
  rows: readonly ClassifiedRow[],
): HolidayImportResult['counts'] {
  const counts = { new: 0, duplicate: 0, error: 0 };
  for (const row of rows) {
    if (row.status === 'NEW') counts.new += 1;
    else if (row.status === 'DUPLICATE') counts.duplicate += 1;
    else counts.error += 1;
  }
  return counts;
}
