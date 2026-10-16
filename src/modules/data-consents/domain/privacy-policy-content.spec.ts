import {
  missingSensitiveHealthElements,
  normalizePolicyContent,
  policyContentHash,
  policyVersionLabel,
} from './privacy-policy-content';

const COMPLETE =
  'Autorizo el tratamiento de mis datos sensibles de salud (historia clínica, ' +
  'odontograma, radiografías). No está obligado a autorizar el tratamiento de ' +
  'datos sensibles. Finalidad: prestar la atención odontológica.';

describe('missingSensitiveHealthElements', () => {
  it('acepta un texto con las tres frases obligatorias del Dec. 1377', () => {
    expect(missingSensitiveHealthElements(COMPLETE)).toEqual([]);
  });

  it('no distingue mayúsculas ni tildes, y admite «obligada»', () => {
    const text =
      'NO ESTA OBLIGADA a autorizar. Se consideran DATOS SENSIBLES los de salud. La FINALIDAD es atenderle.';
    expect(missingSensitiveHealthElements(text)).toEqual([]);
  });

  it('admite la redacción en primera persona o «no es obligatoria»', () => {
    const tail = ' Mis datos sensibles se usan con la finalidad de atenderme.';
    expect(
      missingSensitiveHealthElements(`No estoy obligado a autorizar.${tail}`),
    ).toEqual([]);
    expect(
      missingSensitiveHealthElements(
        `La autorización no es obligatoria.${tail}`,
      ),
    ).toEqual([]);
  });

  it('detecta cada frase que falta', () => {
    expect(
      missingSensitiveHealthElements('Autorizo el uso de mis datos.'),
    ).toEqual(['NOT_OBLIGED', 'SENSITIVE_DATA', 'PURPOSE']);
    expect(
      missingSensitiveHealthElements(
        'Mis datos sensibles se usan con la finalidad de atenderme.',
      ),
    ).toEqual(['NOT_OBLIGED']);
  });
});

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
