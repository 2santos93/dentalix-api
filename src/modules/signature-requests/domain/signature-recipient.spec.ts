import {
  SIGNATURE_MINOR_NO_RESPONSIBLE_MESSAGE,
  SIGNATURE_NO_EMAIL_MESSAGE,
  SIGNATURE_OPTED_OUT_MESSAGE,
  resolveSignatureRecipient,
  type SignatureRecipientInput,
} from './signature-recipient';

const adult: SignatureRecipientInput = {
  patient: {
    firstName: 'Laura María',
    lastName: 'Castro',
    birthDate: new Date('1992-03-14T00:00:00.000Z'),
    email: ' laura@example.com ',
    emergencyContactName: null,
    reminderOptOutAt: null,
    contactChannel: 'EMAIL',
    document: 'Cédula 1020',
  },
  responsibles: [],
  majorityAge: 18,
  today: '2026-10-30',
};

const mother = {
  id: 'r1',
  name: 'Claudia Navarro',
  email: 'claudia@example.com',
  isPayer: false,
  receivesNotices: true,
  optedOut: false,
  documentText: 'Cédula C01',
};

const minor: SignatureRecipientInput = {
  ...adult,
  patient: {
    ...adult.patient,
    firstName: 'Sofía',
    lastName: 'Ortiz',
    birthDate: new Date('2015-02-11T00:00:00.000Z'),
    email: 'familia@example.com',
  },
  responsibles: [mother],
};

describe('a quién va la firma a distancia (DX-243)', () => {
  it('un adulto con email: firma él (PATIENT), con su nombre completo y documento', () => {
    expect(resolveSignatureRecipient(adult)).toEqual({
      ok: true,
      signerType: 'PATIENT',
      signerName: 'Laura María Castro',
      signerDocument: 'Cédula 1020',
      email: 'laura@example.com',
      greetingName: 'Laura',
      patientFirstName: null,
      minor: false,
    });
  });

  it('un adulto sin email no se envía a su responsable: hay que añadirle el email', () => {
    expect(
      resolveSignatureRecipient({
        ...adult,
        patient: { ...adult.patient, email: null },
        responsibles: [mother],
      }),
    ).toEqual({ ok: false, reason: SIGNATURE_NO_EMAIL_MESSAGE });
  });

  it('un menor (según la mayoría de la clínica): va al responsable, que firma como GUARDIAN con su nombre', () => {
    expect(resolveSignatureRecipient(minor)).toEqual({
      ok: true,
      signerType: 'GUARDIAN',
      signerName: 'Claudia Navarro',
      signerDocument: 'Cédula C01',
      email: 'claudia@example.com',
      greetingName: 'Claudia',
      patientFirstName: 'Sofía',
      minor: true,
    });
  });

  it('la mayoría de edad la pone la clínica (DX-328): con 21 un paciente de 19 es menor', () => {
    const nineteen = {
      ...adult,
      patient: {
        ...adult.patient,
        birthDate: new Date('2007-05-01T00:00:00.000Z'),
      },
      responsibles: [mother],
    };
    expect(resolveSignatureRecipient(nineteen)).toMatchObject({
      signerType: 'PATIENT',
    });
    expect(
      resolveSignatureRecipient({ ...nineteen, majorityAge: 21 }),
    ).toMatchObject({ signerType: 'GUARDIAN', signerName: 'Claudia Navarro' });
  });

  it('un menor con responsable sin email no se envía al email de la ficha (podría ser el del menor)', () => {
    expect(
      resolveSignatureRecipient({
        ...minor,
        responsibles: [{ ...mother, email: null, documentText: null }],
      }),
    ).toEqual({ ok: false, reason: SIGNATURE_MINOR_NO_RESPONSIBLE_MESSAGE });
  });

  it('un menor sin responsable registrado no se envía (ni al contacto de emergencia)', () => {
    expect(
      resolveSignatureRecipient({
        ...minor,
        patient: { ...minor.patient, emergencyContactName: 'Rosa' },
        responsibles: [],
      }),
    ).toEqual({ ok: false, reason: SIGNATURE_MINOR_NO_RESPONSIBLE_MESSAGE });
  });

  it('un paciente dado de baja de los envíos (o con canal NONE) no recibe nada', () => {
    expect(
      resolveSignatureRecipient({
        ...adult,
        patient: { ...adult.patient, reminderOptOutAt: new Date() },
      }),
    ).toEqual({ ok: false, reason: SIGNATURE_OPTED_OUT_MESSAGE });
    expect(
      resolveSignatureRecipient({
        ...adult,
        patient: { ...adult.patient, contactChannel: 'NONE' },
      }),
    ).toEqual({ ok: false, reason: SIGNATURE_OPTED_OUT_MESSAGE });
  });
});
