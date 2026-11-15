import {
  CLINICAL_RECORD_COPY_MESSAGES as M,
  checkCopyRequest,
} from './clinical-record-copy';
import { AUDIT_RECORD_COPY_SECTIONS } from '../../audit/domain/audit-metadata';

const TODAY = '2026-11-15';

describe('checkCopyRequest (DX-456)', () => {
  const base = {
    from: '2026-01-01',
    to: '2026-03-31',
    sections: ['EVOLUTIONS'],
  };

  it('acepta un período válido y devuelve las secciones en el orden del documento', () => {
    const check = checkCopyRequest(
      { ...base, sections: ['APPOINTMENTS', 'CONSENTS', 'EVOLUTIONS'] },
      TODAY,
    );
    expect(check).toEqual({
      ok: true,
      value: {
        from: '2026-01-01',
        to: '2026-03-31',
        sections: ['EVOLUTIONS', 'CONSENTS', 'APPOINTMENTS'],
        deliveredTo: null,
      },
    });
  });

  it('admite un solo día y un «hasta» futuro (citas agendadas)', () => {
    expect(
      checkCopyRequest({ ...base, from: TODAY, to: '2026-12-31' }, TODAY).ok,
    ).toBe(true);
  });

  it.each([
    ['fecha que no existe', { from: '2026-02-30' }, M.invalidPeriod],
    ['desde posterior a hasta', { from: '2026-04-01' }, M.invalidPeriod],
    ['fuera del rango admitido', { from: '1999-12-31' }, M.periodOutOfRange],
    [
      'empieza después de hoy en la sede',
      { from: '2026-11-16', to: '2026-11-30' },
      M.futurePeriod,
    ],
    ['sin secciones', { sections: [] }, M.noSections],
    ['sección desconocida', { sections: ['NOTES'] }, M.unknownSection],
    [
      'sección repetida',
      { sections: ['EVOLUTIONS', 'EVOLUTIONS'] },
      M.repeatedSection,
    ],
    [
      '«entregado a» con salto de línea',
      { deliveredTo: 'Ana\nPérez' },
      M.deliveredToLines,
    ],
    [
      '«entregado a» demasiado largo',
      { deliveredTo: 'x'.repeat(121) },
      M.deliveredToTooLong,
    ],
  ])('rechaza: %s', (_label, patch, message) => {
    expect(checkCopyRequest({ ...base, ...patch }, TODAY)).toEqual({
      ok: false,
      message,
    });
  });

  it('recorta «entregado a» y lo deja en null si queda vacío', () => {
    const named = checkCopyRequest(
      { ...base, deliveredTo: '  Ana Pérez (madre)  ' },
      TODAY,
    );
    expect(named.ok && named.value.deliveredTo).toBe('Ana Pérez (madre)');
    const blank = checkCopyRequest({ ...base, deliveredTo: '   ' }, TODAY);
    expect(blank.ok && blank.value.deliveredTo).toBeNull();
  });

  it('las secciones son las mismas que admite la auditoría', () => {
    const all = [...AUDIT_RECORD_COPY_SECTIONS].reverse();
    const check = checkCopyRequest({ ...base, sections: all }, TODAY);
    expect(check.ok && check.value.sections).toEqual([
      ...AUDIT_RECORD_COPY_SECTIONS,
    ]);
  });
});
