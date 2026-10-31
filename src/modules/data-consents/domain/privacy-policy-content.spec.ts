import {
  normalizePolicyContent,
  policyContentHash,
  policyVersionLabel,
} from './privacy-policy-content';

const COMPLETE =
  'Autorizo el tratamiento de mis datos sensibles de salud (historia clínica, ' +
  'odontograma, radiografías). No está obligado a autorizar el tratamiento de ' +
  'datos sensibles. Finalidad: prestar la atención odontológica.';

describe('policyContentHash', () => {
  const content = {
    policyText: 'Política',
    generalText: 'General',
    sensitiveHealthText: COMPLETE,
    marketingText: 'Marketing',
  };

  it('es un sha256 hexadecimal estable', () => {
    const hash = policyContentHash(content);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(policyContentHash({ ...content })).toBe(hash);
  });

  it('policyContentHash conserva el hash de las versiones ya publicadas', () => {
    expect(policyContentHash(content)).toBe(
      '56079ae2db7a30d967f06f2ded0a11ff7d2d9c3968a9af486a12a96f837a9881',
    );
  });

  it('cambia si cambia cualquier texto, y no confunde dónde acaba cada uno', () => {
    const base = policyContentHash(content);
    expect(policyContentHash({ ...content, marketingText: 'Otro' })).not.toBe(
      base,
    );
    expect(
      policyContentHash({
        ...content,
        policyText: 'PolíticaGeneral',
        generalText: '',
      }),
    ).not.toBe(base);
  });
});

describe('normalizePolicyContent', () => {
  it('recorta espacios de los extremos y unifica saltos de línea', () => {
    expect(
      normalizePolicyContent({
        policyText: '  Política\r\nlínea 2  ',
        generalText: ' General ',
        sensitiveHealthText: COMPLETE,
        marketingText: 'Marketing\n',
      }),
    ).toEqual({
      policyText: 'Política\nlínea 2',
      generalText: 'General',
      sensitiveHealthText: COMPLETE,
      marketingText: 'Marketing',
    });
  });
});

describe('policyVersionLabel', () => {
  it('es la etiqueta que se guarda en el campo derivado del paciente', () => {
    expect(policyVersionLabel(3)).toBe('v3');
  });
});
