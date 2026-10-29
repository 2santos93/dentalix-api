import type { ImportPatientData } from '../domain/import-fields';
import {
  importRowDataFromJson,
  importedPatientData,
  storedImportRowData,
} from './prisma-patient-import.repository';

// DX-327 (R5, R6, spec §4.7): las filas preparadas de la importación llevan
// el código anterior (para un worker anterior durante el despliegue) y el
// tipo genérico, y ninguna etiqueta; el lector las traduce sin etiqueta.
const row = (docType: ImportPatientData['docType']): ImportPatientData => ({
  docType,
  docNumber: 'RX1',
  firstName: 'Ana',
  lastName: 'Ejemplo',
});

describe('filas de la importación (DX-327)', () => {
  it('import rows are stored with the legacy code and the generic type, and no label', () => {
    expect(storedImportRowData(row('NATIONAL_ID'))).toStrictEqual({
      docType: 'CC',
      documentType: 'NATIONAL_ID',
      docNumber: 'RX1',
      firstName: 'Ana',
      lastName: 'Ejemplo',
    });
    // Caso documentado (spec §7): un worker anterior lee el código anterior
    // y crea el paciente OTHER; el genérico TAX_ID solo lo lee la API nueva.
    expect(storedImportRowData(row('TAX_ID'))).toMatchObject({
      docType: 'OTHER',
      documentType: 'TAX_ID',
    });
    for (const stored of [
      storedImportRowData(row('PASSPORT')),
      storedImportRowData(row('RESIDENCE_PERMIT')),
    ]) {
      expect(stored).not.toHaveProperty('docTypeLabel');
    }
  });

  it('legacy stored import rows with CC are read as NATIONAL_ID with no label', () => {
    // Fila escrita por la API anterior: solo el código.
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
    // Fila de la API nueva: manda el genérico, aunque el código diga OTHER.
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
      docType: 'OTHER',
      docNumber: 'RX1',
      birthDate: new Date('1990-05-03T00:00:00.000Z'),
      sex: 'F',
      createdAt: now,
    });
    expect(created).not.toHaveProperty('docTypeLabel');
  });
});
