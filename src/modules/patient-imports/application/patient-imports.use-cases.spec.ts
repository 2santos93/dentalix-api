import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  BatchLocationError,
  type BatchLocation,
} from '../infrastructure/prisma-patient-import.repository';
import type { PrismaPatientImportRepository } from '../infrastructure/prisma-patient-import.repository';
import type { BatchRow } from '../infrastructure/prisma-patient-import.repository';
import type { NewBatch } from '../infrastructure/prisma-patient-import.repository';
import type { JobQueue } from '../../jobs/application/job-queue.service';
import { FixedDocumentTypeNamesReader } from '../../document-type-names/__fixtures__/fixed-document-type-names.reader';
import {
  LOCATION_MESSAGE,
  PatientImportsService,
  mappingOf,
  type UploadedFile,
} from './patient-imports.use-cases';

/**
 * G1-B: la sede del lote se lee ANTES que el fichero; sus errores con
 * cifras se dicen en el formato de esa sede.
 */
function makeUseCases(batchLocation: () => Promise<BatchLocation>) {
  return new PatientImportsService(
    { batchLocation } as unknown as PrismaPatientImportRepository,
    {} as JobQueue,
    new FixedDocumentTypeNamesReader(),
  );
}

const location = (overrides: Partial<BatchLocation> = {}): BatchLocation => ({
  id: 'loc-1',
  country: 'CO',
  timeZone: 'America/New_York',
  currency: 'USD',
  locale: 'en-US',
  hourCycle: 'h12',
  ...overrides,
});

const file = (text: string, originalname = 'pacientes.csv'): UploadedFile => {
  const buffer = Buffer.from(text, 'utf8');
  return { buffer, originalname, size: buffer.length };
};

/** 10.001 filas con datos: el tope de la importación. */
const tooManyRows = () =>
  file(
    [
      'nombres,documento',
      ...Array.from({ length: 10_001 }, (_, i) => `x${i},${i}`),
    ].join('\n'),
  );

const errorOf = (run: () => Promise<unknown>) =>
  run().then(
    () => {
      throw new Error('no lanzó');
    },
    (e: unknown) => e,
  );

describe('PatientImportsService: sede del lote antes que el fichero (G1-B)', () => {
  it('import without a valid write location fails before parsing', async () => {
    const uc = makeUseCases(() => Promise.reject(new BatchLocationError()));
    // Un fichero que no se puede leer: gana la sede, no el error del fichero.
    for (const run of [
      () => uc.inspect(file('', 'pacientes.pdf')),
      () => uc.dryRun(file('', 'pacientes.pdf'), { columns: null }, 'u1'),
    ]) {
      const err = await errorOf(run);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toBe(LOCATION_MESSAGE);
    }
  });

  it('import row limit message at an en-US location reads 10,000', async () => {
    const uc = makeUseCases(() => Promise.resolve(location()));
    const err = await errorOf(() => uc.inspect(tooManyRows()));
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toBe(
      'El archivo tiene más de 10,000 filas de pacientes. Divídelo en varios archivos.',
    );
  });

  it('a location without hourCycle is 409 only when the message has numbers', async () => {
    const uc = makeUseCases(() =>
      Promise.resolve(location({ hourCycle: null })),
    );
    const err = await errorOf(() => uc.inspect(tooManyRows()));
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'LOCATION_LOCALE_REQUIRED',
      locationId: 'loc-1',
    });
    // Un fichero que se lee bien no pinta nada: sin 409.
    await expect(
      uc.inspect(file('nombres,documento\nAna,1')),
    ).resolves.toMatchObject({ totalRows: 1 });
  });
});

describe('PatientImportsService: tipos de documento genéricos (DX-327)', () => {
  it('a stored legacy default type is read as its generic type', () => {
    const batch = (columnMapping: unknown) => ({ columnMapping }) as BatchRow;
    // Lote guardado por la API anterior: solo el código.
    expect(
      mappingOf(batch({ columns: { docNumber: 'doc' }, defaultDocType: 'TI' })),
    ).toEqual({ columns: { docNumber: 'doc' }, defaultDocType: 'NATIONAL_ID' });
    // Lote de la API nueva: el genérico manda sobre la proyección.
    expect(
      mappingOf(
        batch({
          columns: {},
          defaultDocType: 'OTHER',
          defaultDocumentType: 'TAX_ID',
        }),
      ),
    ).toEqual({ columns: {}, defaultDocType: 'TAX_ID' });
  });

  it('the dry-run reads the clinic names once per batch and stores both default types', async () => {
    const names = new FixedDocumentTypeNamesReader({ TAX_ID: 'Nombre Local' });
    let saved: NewBatch | undefined;
    const repo = {
      batchLocation: () => Promise.resolve(location()),
      existingDocs: () => Promise.resolve([]),
      createBatch: (input: NewBatch) => {
        saved = input;
        return Promise.resolve({
          ...input,
          id: 'b1',
          status: 'VALIDATED',
          createdAt: new Date(),
          preparedRows: input.rows.length,
          processedRows: 0,
          balancePreparedRows: 0,
          balanceProcessedRows: 0,
          balanceFileName: null,
          balanceFileSha256: null,
        });
      },
      userNames: () => Promise.resolve(new Map()),
    } as unknown as PrismaPatientImportRepository;
    const uc = new PatientImportsService(repo, {} as JobQueue, names);
    const detail = await uc.dryRun(
      file(
        [
          'tipo;doc;nombres;apellidos',
          'nombre local;RX-1;Ana;Uno',
          ';RX-2;Luis;Dos',
          'Pasaporte;RX-3;Eva;Tres',
        ].join('\n'),
      ),
      {
        columns: {
          docType: 'tipo',
          docNumber: 'doc',
          firstName: 'nombres',
          lastName: 'apellidos',
        },
        defaultDocType: 'TAX_ID',
      },
      'u1',
    );
    expect(names.reads).toBe(1);
    expect(detail.issues).toEqual([]);
    expect(saved?.rows.map((r) => r.data.docType)).toEqual([
      'TAX_ID',
      'TAX_ID',
      'PASSPORT',
    ]);
    expect(saved?.columnMapping).toMatchObject({
      defaultDocType: 'OTHER',
      defaultDocumentType: 'TAX_ID',
    });
    expect(detail.columnMapping.defaultDocType).toBe('TAX_ID');
  });
});
