import type { ImportPatientData } from '../domain/import-fields';
import {
  importRowDataFromJson,
  importedPatientData,
  storedImportRowData,
} from './prisma-patient-import.repository';

// DX-327 (R6, spec §4.7): las filas preparadas de la importación llevan el
// tipo genérico y ninguna etiqueta; el lector traduce sin etiqueta las filas
// preparadas antes de 20261110130000 (con el código anterior).
const row = (docType: ImportPatientData['docType']): ImportPatientData => ({
  docType,
  docNumber: 'RX1',
  firstName: 'Ana',
  lastName: 'Ejemplo',
});

describe('filas de la importación (DX-327)', () => {
  it('import rows are stored with the generic type only, and no label', () => {
    expect(storedImportRowData(row('NATIONAL_ID'))).toStrictEqual({
      documentType: 'NATIONAL_ID',
      docNumber: 'RX1',
      firstName: 'Ana',
      lastName: 'Ejemplo',
    });
    expect(storedImportRowData(row('TAX_ID'))).toStrictEqual({
      documentType: 'TAX_ID',
      docNumber: 'RX1',
      firstName: 'Ana',
      lastName: 'Ejemplo',
    });
    for (const stored of [
      storedImportRowData(row('PASSPORT')),
      storedImportRowData(row('RESIDENCE_PERMIT')),
    ]) {
      expect(stored).not.toHaveProperty('docTypeLabel');
    }
  });

  it('import rows prepared before 20261110130000 with the old code are read as their generic type with no label', () => {
    // Fila escrita por la API anterior a DX-327: solo el código.
    expect(
      importRowDataFromJson({
        docType: 'CC',
        docNumber: '123',
        firstName: 'Ana',
        lastName: 'B',
      }),
    ).toStrictEqual({
      docType: 'NATIONAL_ID',
      docNumber: '123',
      firstName: 'Ana',
      lastName: 'B',
    });
    expect(importRowDataFromJson({ docType: 'TI' }).docType).toBe(
      'NATIONAL_ID',
    );
    expect(importRowDataFromJson({ docType: 'CE' }).docType).toBe(
      'RESIDENCE_PERMIT',
    );
    // Fila de fase 1: manda el genérico, aunque el código diga OTHER.
    expect(
      importRowDataFromJson({ docType: 'OTHER', documentType: 'TAX_ID' })
        .docType,
    ).toBe('TAX_ID');
    expect(
      importRowDataFromJson(storedImportRowData(row('TAX_ID'))),
    ).toStrictEqual(row('TAX_ID'));
    // Un código que nadie escribió es un fallo de despliegue (la fila queda
    // FAILED, como cualquier error suyo).
    expect(() => importRowDataFromJson({ docType: 'XX' })).toThrow(/DX-327/);
  });

  it('created patients have no label', () => {
    const now = new Date('2026-10-29T12:00:00Z');
    const created = importedPatientData(
      { ...row('TAX_ID'), birthDate: '1990-05-03', sex: 'F' },
      {
        tenantId: 't1',
        importBatchId: 'b1',
        contactChannel: 'EMAIL',
        createdById: 'u1',
        now,
      },
    );
    expect(created).toMatchObject({
      documentType: 'TAX_ID',
      docNumber: 'RX1',
      birthDate: new Date('1990-05-03T00:00:00.000Z'),
      sex: 'F',
      createdAt: now,
    });
    expect(created).not.toHaveProperty('docTypeLabel');
    expect(created).not.toHaveProperty('docType');
  });
});
