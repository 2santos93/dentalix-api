import {
  exportFileKey,
  exportFileName,
  sizeLabel,
  stateOf,
  viewOf,
  type ClinicExportRecord,
} from './clinic-export';
import { isFileKey } from '../../../shared/storage/file-key';

const NOW = new Date('2026-11-21T12:00:00Z');
const base: ClinicExportRecord = {
  id: '0195f1d0-0000-7000-8000-000000000001',
  status: 'READY',
  requestedById: 'u1',
  requestedByName: 'Ana Rodríguez',
  requestedAt: new Date('2026-11-21T10:00:00Z'),
  startedAt: new Date('2026-11-21T10:00:01Z'),
  completedAt: new Date('2026-11-21T10:01:00Z'),
  errorCode: null,
  sizeBytes: 2_500_000,
  fileCount: 3,
  rowCounts: { 'pacientes.csv': 10, 'citas.csv': 5, 'LEEME.txt': 0 },
  downloadExpiresAt: new Date('2026-11-22T10:01:00Z'),
  downloadedAt: null,
  downloadedByName: null,
  fileDeletedAt: null,
};

describe('Exportación de la clínica: estado y formatos (DX-053)', () => {
  it('READY dentro de las 24 h se puede descargar', () => {
    expect(stateOf(base, NOW)).toBe('READY');
    expect(viewOf(base, NOW)).toMatchObject({
      state: 'READY',
      canDownload: true,
      totalRows: 15,
    });
  });

  it('descargada, caducada o con el fichero borrado ya no', () => {
    expect(stateOf({ ...base, downloadedAt: NOW }, NOW)).toBe('DOWNLOADED');
    expect(
      stateOf(
        { ...base, downloadExpiresAt: new Date('2026-11-21T12:00:00Z') },
        NOW,
      ),
    ).toBe('EXPIRED');
    expect(stateOf({ ...base, fileDeletedAt: NOW }, NOW)).toBe('EXPIRED');
    expect(viewOf({ ...base, downloadedAt: NOW }, NOW).canDownload).toBe(false);
  });

  it('el resto de estados tal cual', () => {
    for (const status of ['PENDING', 'RUNNING', 'FAILED'] as const) {
      expect(stateOf({ ...base, status }, NOW)).toBe(status);
      expect(viewOf({ ...base, status }, NOW).canDownload).toBe(false);
    }
  });

  it('clave del almacén válida y solo con ids; nombre de descarga con la fecha', () => {
    const key = exportFileKey(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    );
    expect(isFileKey(key)).toBe(true);
    expect(key).toBe(
      'clinic-exports/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.zip',
    );
    expect(exportFileName(base.completedAt!)).toBe(
      'exportacion-dentalix-2026-11-21.zip',
    );
  });

  it('tamaño legible con coma decimal', () => {
    expect(sizeLabel(512)).toBe('512 B');
    expect(sizeLabel(2048)).toBe('2,0 KB');
    expect(sizeLabel(2_500_000)).toBe('2,4 MB');
    expect(sizeLabel(3 * 1024 ** 3)).toBe('3,0 GB');
  });
});
