import {
  cleanReferredByName,
  decideAcquisition,
  NO_ACQUISITION,
  sameAcquisition,
  touchesAcquisition,
  type AcquisitionSource,
  type PatientAcquisition,
} from './patient-acquisition';

const INSTAGRAM: AcquisitionSource = {
  id: 'src-ig',
  kind: 'CHANNEL',
  isActive: true,
};
const REFERRAL: AcquisitionSource = {
  id: 'src-ref',
  kind: 'PATIENT',
  isActive: true,
};
const DOCTOR: AcquisitionSource = {
  id: 'src-doc',
  kind: 'EXTERNAL_PROFESSIONAL',
  isActive: true,
};
const OLD: AcquisitionSource = {
  id: 'src-old',
  kind: 'CHANNEL',
  isActive: false,
};

describe('decideAcquisition (DX-172)', () => {
  it('la fuente es opcional: sin nada, nada', () => {
    expect(decideAcquisition(NO_ACQUISITION, {}, null)).toEqual({
      ok: true,
      value: NO_ACQUISITION,
    });
  });

  it('alta con «Recomendación de paciente» y el referente', () => {
    expect(
      decideAcquisition(
        NO_ACQUISITION,
        { sourceId: 'src-ref', referredByPatientId: 'p-ana' },
        REFERRAL,
      ),
    ).toEqual({
      ok: true,
      value: {
        sourceId: 'src-ref',
        referredByPatientId: 'p-ana',
        referredByName: null,
      },
    });
  });

  it('el referente es opcional también con la fuente de tipo PATIENT', () => {
    expect(
      decideAcquisition(NO_ACQUISITION, { sourceId: 'src-ref' }, REFERRAL),
    ).toEqual({
      ok: true,
      value: {
        sourceId: 'src-ref',
        referredByPatientId: null,
        referredByName: null,
      },
    });
  });

  it('profesional externo: el nombre recortado y con espacios colapsados', () => {
    expect(
      decideAcquisition(
        NO_ACQUISITION,
        { sourceId: 'src-doc', referredByName: '  Dra.   Carmen  Rojas ' },
        DOCTOR,
      ),
    ).toEqual({
      ok: true,
      value: {
        sourceId: 'src-doc',
        referredByPatientId: null,
        referredByName: 'Dra. Carmen Rojas',
      },
    });
  });

  it('un nombre de más de 120 caracteres no vale', () => {
    expect(
      decideAcquisition(
        NO_ACQUISITION,
        { sourceId: 'src-doc', referredByName: 'a'.repeat(121) },
        DOCTOR,
      ),
    ).toEqual({ ok: false, problem: 'nameTooLong' });
  });

  it('un referente explícito con una fuente que no es de pacientes es un error', () => {
    expect(
      decideAcquisition(
        NO_ACQUISITION,
        { sourceId: 'src-ig', referredByPatientId: 'p-ana' },
        INSTAGRAM,
      ),
    ).toEqual({ ok: false, problem: 'referrerNeedsPatientSource' });
    expect(
      decideAcquisition(
        NO_ACQUISITION,
        { sourceId: 'src-ref', referredByName: 'Dr. Luis Pérez' },
        REFERRAL,
      ),
    ).toEqual({ ok: false, problem: 'nameNeedsProfessionalSource' });
  });

  it('sin fuente no hay referente ni nombre', () => {
    expect(
      decideAcquisition(NO_ACQUISITION, { referredByPatientId: 'p-ana' }, null),
    ).toEqual({ ok: false, problem: 'referralNeedsSource' });
  });

  it('una fuente que no es de la clínica (o no existe) es un error', () => {
    expect(
      decideAcquisition(NO_ACQUISITION, { sourceId: 'src-ajena' }, null),
    ).toEqual({ ok: false, problem: 'sourceNotFound' });
  });

  it('asignar una desactivada no vale; conservarla sí', () => {
    expect(
      decideAcquisition(NO_ACQUISITION, { sourceId: 'src-old' }, OLD),
    ).toEqual({ ok: false, problem: 'sourceInactive' });
    const stored: PatientAcquisition = {
      sourceId: 'src-old',
      referredByPatientId: null,
      referredByName: null,
    };
    expect(decideAcquisition(stored, { sourceId: 'src-old' }, OLD)).toEqual({
      ok: true,
      value: stored,
    });
  });

  it('cambiar de fuente vacía lo que ya no encaja sin pedirlo', () => {
    const stored: PatientAcquisition = {
      sourceId: 'src-ref',
      referredByPatientId: 'p-ana',
      referredByName: null,
    };
    expect(
      decideAcquisition(stored, { sourceId: 'src-ig' }, INSTAGRAM),
    ).toEqual({
      ok: true,
      value: {
        sourceId: 'src-ig',
        referredByPatientId: null,
        referredByName: null,
      },
    });
  });

  it('editar solo el referente conserva la fuente', () => {
    const stored: PatientAcquisition = {
      sourceId: 'src-ref',
      referredByPatientId: 'p-ana',
      referredByName: null,
    };
    expect(
      decideAcquisition(stored, { referredByPatientId: 'p-luis' }, REFERRAL),
    ).toEqual({
      ok: true,
      value: {
        sourceId: 'src-ref',
        referredByPatientId: 'p-luis',
        referredByName: null,
      },
    });
  });

  it('vaciar la fuente vacía también el referente', () => {
    const stored: PatientAcquisition = {
      sourceId: 'src-ref',
      referredByPatientId: 'p-ana',
      referredByName: null,
    };
    expect(decideAcquisition(stored, { sourceId: null }, null)).toEqual({
      ok: true,
      value: NO_ACQUISITION,
    });
  });
});

describe('ayudas de la captación', () => {
  it('touchesAcquisition: solo si llega algún campo (null cuenta)', () => {
    expect(touchesAcquisition({})).toBe(false);
    expect(touchesAcquisition({ sourceId: null })).toBe(true);
    expect(touchesAcquisition({ referredByName: 'x' })).toBe(true);
  });

  it('cleanReferredByName: vacío = null; ausente sigue ausente', () => {
    expect(cleanReferredByName('   ')).toBeNull();
    expect(cleanReferredByName(undefined)).toBeUndefined();
    expect(cleanReferredByName(null)).toBeNull();
  });

  it('sameAcquisition compara los tres campos', () => {
    expect(sameAcquisition(NO_ACQUISITION, { ...NO_ACQUISITION })).toBe(true);
    expect(
      sameAcquisition(NO_ACQUISITION, { ...NO_ACQUISITION, sourceId: 'x' }),
    ).toBe(false);
  });
});
