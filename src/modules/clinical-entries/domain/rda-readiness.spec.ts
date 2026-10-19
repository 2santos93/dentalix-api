import { computeRdaReadiness, type RdaFacts } from './rda-readiness';

const complete: RdaFacts = {
  country: 'CO',
  location: {
    id: 'loc-1',
    name: 'Sede principal',
    repsHabilitationCode: '110010123401',
  },
  patient: { id: 'p1', docNumber: '1020304050' },
  hasPrincipalDiagnosis: true,
  performedItems: [
    { catalogItemId: 'ci-1', name: 'Resina 1 superficie', cupsCode: '232101' },
  ],
  author: {
    userId: 'u1',
    name: 'Dra. Ríos',
    professionalLicense: 'RETHUS-123',
  },
};

describe('computeRdaReadiness (DX-212)', () => {
  it('atención completa en sede CO: lista, y el NIT queda pendiente de DX-019 sin bloquear', () => {
    expect(computeRdaReadiness(complete)).toEqual({
      notApplicable: false,
      ready: true,
      missing: [],
      pending: [
        {
          code: 'CLINIC_TAX_ID',
          label: 'NIT de la clínica',
          reason: 'pendiente de DX-019',
        },
      ],
    });
  });

  it('sede ES: no aplica (sin faltantes ni pendientes)', () => {
    expect(computeRdaReadiness({ ...complete, country: 'ES' })).toEqual({
      notApplicable: true,
      ready: false,
      missing: [],
      pending: [],
    });
  });

  it('un ítem realizado sin CUPS sale con su nombre (una vez aunque se repita)', () => {
    const result = computeRdaReadiness({
      ...complete,
      performedItems: [
        ...complete.performedItems,
        { catalogItemId: 'ci-2', name: 'Profilaxis', cupsCode: null },
        { catalogItemId: 'ci-2', name: 'Profilaxis', cupsCode: null },
      ],
    });
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual([
      {
        code: 'PROCEDURE_CUPS',
        label: 'Código CUPS de «Profilaxis»',
        resourceId: 'ci-2',
      },
    ]);
  });

  it('una evolución antigua sin nada: todos los faltantes en orden', () => {
    const result = computeRdaReadiness({
      country: 'CO',
      location: {
        id: 'loc-1',
        name: 'Sede principal',
        repsHabilitationCode: null,
      },
      patient: { id: 'p1', docNumber: null },
      hasPrincipalDiagnosis: false,
      performedItems: [],
      author: { userId: null, name: null, professionalLicense: null },
    });
    expect(result.ready).toBe(false);
    expect(result.missing.map((m) => m.code)).toEqual([
      'PATIENT_DOCUMENT',
      'PRINCIPAL_DIAGNOSIS',
      'LOCATION_REPS',
      'AUTHOR_LICENSE',
    ]);
    expect(result.missing[2]).toEqual({
      code: 'LOCATION_REPS',
      label: 'Código de habilitación (REPS) de «Sede principal»',
      resourceId: 'loc-1',
    });
    expect(result.missing[3].label).toBe(
      'Registro profesional del autor (la evolución no tiene autor)',
    );
  });

  it('documento en blanco cuenta como faltante; el registro profesional nombra al autor', () => {
    const result = computeRdaReadiness({
      ...complete,
      patient: { id: 'p1', docNumber: '  ' },
      author: { ...complete.author, professionalLicense: null },
    });
    expect(result.missing).toEqual([
      {
        code: 'PATIENT_DOCUMENT',
        label: 'Documento de identidad del paciente',
        resourceId: 'p1',
      },
      {
        code: 'AUTHOR_LICENSE',
        label: 'Registro profesional de Dra. Ríos',
        resourceId: 'u1',
      },
    ]);
  });
});
