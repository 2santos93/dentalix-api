import { randomUUID } from 'node:crypto';
import { sanitizeAuditMetadata } from './audit-metadata';

describe('sanitizeAuditMetadata (DX-009)', () => {
  const id = randomUUID();

  it('conserva nombres de campo, ids de la ruta y códigos', () => {
    expect(
      sanitizeAuditMetadata({
        changedFields: ['firstName', 'allergies', 'phone'],
        params: { patientId: id, fdi: '11' },
        reason: 'INVALID_CREDENTIALS',
      }),
    ).toEqual({
      changedFields: ['allergies', 'firstName', 'phone'],
      params: { patientId: id, fdi: '11' },
      reason: 'INVALID_CREDENTIALS',
    });
  });

  it('descarta cualquier clave fuera de la lista (texto clínico, firmas, importes)', () => {
    expect(
      sanitizeAuditMetadata({
        note: 'Paciente alérgica a la penicilina',
        diagnosis: 'Caries profunda',
        signaturePng: 'data:image/png;base64,iVBORw0KGgo=',
        amount: 150000,
      }),
    ).toEqual({});
  });

  it('un "nombre de campo" que no es un identificador no pasa (no se cuela texto)', () => {
    expect(
      sanitizeAuditMetadata({
        changedFields: [
          'notes',
          'alergia a la penicilina',
          'x'.repeat(65),
          42,
          'data:image/png;base64,AAAA',
        ],
      }),
    ).toEqual({ changedFields: ['notes'] });
  });

  it('un parámetro de ruta solo se guarda si es un UUID o un número corto', () => {
    expect(
      sanitizeAuditMetadata({
        params: {
          id,
          fdi: '48',
          token: 'abc.def.ghi',
          name: 'Juan Pérez',
          'bad key': id,
        },
      }),
    ).toEqual({ params: { id, fdi: '48' } });
  });

  it('un código solo es MAYÚSCULAS_CON_GUION_BAJO', () => {
    expect(sanitizeAuditMetadata({ reason: 'clave errónea' })).toEqual({});
  });

  it('acota el número de campos y quita los repetidos', () => {
    const many = Array.from({ length: 80 }, (_, i) => `field${i}`);
    const out = sanitizeAuditMetadata({
      changedFields: [...many, 'field1'],
    });
    expect(out.changedFields).toHaveLength(50);
    expect(new Set(out.changedFields).size).toBe(50);
  });

  it('lo que no es un objeto queda en {}', () => {
    expect(sanitizeAuditMetadata(null)).toEqual({});
    expect(sanitizeAuditMetadata('penicilina')).toEqual({});
    expect(sanitizeAuditMetadata(['a'])).toEqual({});
  });

  it('sin nada que guardar no deja claves vacías', () => {
    expect(sanitizeAuditMetadata({ changedFields: [], params: {} })).toEqual(
      {},
    );
  });
});
