import { representationClause } from './representation-clause';

describe('representationClause (DX-060, m-3)', () => {
  it('identifica al representante, su documento y su relación con el paciente', () => {
    expect(
      representationClause({
        representativeName: 'Marta Pérez',
        representativeDocument: 'V-12.345.678',
        relationship: 'MOTHER',
        patientName: 'Ana Pérez',
      }),
    ).toBe(
      'Firma en representación del paciente: Marta Pérez, identificado(a) con V-12.345.678, ' +
        'otorga este consentimiento en nombre de Ana Pérez, como su madre. Lo que este documento ' +
        'dice en primera persona lo declara Marta Pérez en representación de Ana Pérez.',
    );
  });

  it('sin relación (o «otro») dice «representante»', () => {
    for (const relationship of [undefined, 'OTHER'] as const) {
      expect(
        representationClause({
          representativeName: 'Luis Rojas',
          representativeDocument: 'DOC 1',
          relationship,
          patientName: 'Ana Pérez',
        }),
      ).toContain('en nombre de Ana Pérez, como su representante.');
    }
  });

  it('cada relación tiene su nombre en español', () => {
    const expected = {
      MOTHER: 'madre',
      FATHER: 'padre',
      LEGAL_GUARDIAN: 'tutor legal',
      GRANDPARENT: 'abuelo/a',
      SIBLING: 'hermano/a',
      SPOUSE: 'cónyuge o pareja',
      CHILD: 'hijo/a',
    } as const;
    for (const [relationship, noun] of Object.entries(expected)) {
      expect(
        representationClause({
          representativeName: 'R',
          representativeDocument: 'D',
          relationship: relationship as keyof typeof expected,
          patientName: 'P',
        }),
      ).toContain(`como su ${noun}.`);
    }
  });
});
