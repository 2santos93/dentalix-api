import {
  PRESCRIPTION_COPY_MINOR_NO_EMAIL_MESSAGE,
  PRESCRIPTION_COPY_MINOR_NO_WHATSAPP_MESSAGE,
  PRESCRIPTION_COPY_NO_EMAIL_MESSAGE,
  PRESCRIPTION_COPY_NO_WHATSAPP_MESSAGE,
  PRESCRIPTION_COPY_OPTED_OUT_MESSAGE,
  resolvePrescriptionCopyRecipient,
  type PrescriptionCopyRecipientInput,
  type PrescriptionCopyResponsible,
} from './prescription-copy-recipient';

const ADULT = new Date('1990-05-01T00:00:00Z');
const MINOR = new Date('2015-05-01T00:00:00Z');

function input(
  overrides: Partial<PrescriptionCopyRecipientInput> = {},
  patient: Partial<PrescriptionCopyRecipientInput['patient']> = {},
): PrescriptionCopyRecipientInput {
  return {
    channel: 'EMAIL',
    patient: {
      firstName: 'María José',
      birthDate: ADULT,
      email: 'maria@correo.com',
      phone: '+58 412 1234567',
      reminderOptOutAt: null,
      contactChannel: 'EMAIL',
      ...patient,
    },
    responsibles: [],
    majorityAge: 18,
    today: '2026-11-15',
    phoneRegion: 'VE',
    ...overrides,
  };
}

const responsible = (
  overrides: Partial<PrescriptionCopyResponsible>,
): PrescriptionCopyResponsible => ({
  id: 'r1',
  name: 'Carlos Pérez',
  email: 'carlos@correo.com',
  phone: '0414 7654321',
  isPayer: false,
  receivesNotices: true,
  ...overrides,
});

describe('a quién va la copia de la receta (DX-468)', () => {
  it('un adulto la recibe en su email', () => {
    expect(resolvePrescriptionCopyRecipient(input())).toEqual({
      ok: true,
      kind: 'PATIENT',
      destination: 'maria@correo.com',
      destinationMasked: 'ma***@correo.com',
      greetingName: 'María',
      patientFirstName: null,
      responsiblePartyId: null,
    });
  });

  it('un adulto la recibe por WhatsApp en su móvil (E.164 sin +, con la región de la sede)', () => {
    const r = resolvePrescriptionCopyRecipient(
      input({ channel: 'WHATSAPP' }, { phone: '0412 1234567' }),
    );
    expect(r).toMatchObject({
      ok: true,
      kind: 'PATIENT',
      destination: '584121234567',
      destinationMasked: '••• 4567',
    });
  });

  it('un adulto sin email o sin teléfono: 422 con qué falta', () => {
    expect(
      resolvePrescriptionCopyRecipient(input({}, { email: '  ' })),
    ).toEqual({ ok: false, reason: PRESCRIPTION_COPY_NO_EMAIL_MESSAGE });
    expect(
      resolvePrescriptionCopyRecipient(
        input({ channel: 'WHATSAPP' }, { phone: 'sin número' }),
      ),
    ).toEqual({ ok: false, reason: PRESCRIPTION_COPY_NO_WHATSAPP_MESSAGE });
  });

  it('un adulto nunca va a su responsable', () => {
    const r = resolvePrescriptionCopyRecipient(
      input(
        { responsibles: [responsible({ isPayer: true })] },
        { email: null },
      ),
    );
    expect(r).toEqual({
      ok: false,
      reason: PRESCRIPTION_COPY_NO_EMAIL_MESSAGE,
    });
  });

  it('la baja de los envíos lo impide siempre', () => {
    for (const patient of [
      { reminderOptOutAt: new Date() },
      { contactChannel: 'NONE' as const },
    ]) {
      expect(resolvePrescriptionCopyRecipient(input({}, patient))).toEqual({
        ok: false,
        reason: PRESCRIPTION_COPY_OPTED_OUT_MESSAGE,
      });
    }
  });

  it('un menor la recibe por su responsable que recibe avisos: primero el pagador', () => {
    const r = resolvePrescriptionCopyRecipient(
      input(
        {
          responsibles: [
            responsible({
              id: 'r1',
              name: 'Ana Gómez',
              email: 'ana@correo.com',
            }),
            responsible({ id: 'r2', isPayer: true }),
          ],
        },
        { birthDate: MINOR },
      ),
    );
    expect(r).toEqual({
      ok: true,
      kind: 'RESPONSIBLE',
      destination: 'carlos@correo.com',
      destinationMasked: 'ca***@correo.com',
      greetingName: 'Carlos',
      patientFirstName: 'María',
      responsiblePartyId: 'r2',
    });
  });

  it('un menor: salta al responsable que no recibe avisos o no tiene el contacto del canal', () => {
    const r = resolvePrescriptionCopyRecipient(
      input(
        {
          channel: 'WHATSAPP',
          responsibles: [
            responsible({ id: 'r1', isPayer: true, receivesNotices: false }),
            responsible({ id: 'r2', phone: null }),
            responsible({ id: 'r3', phone: '+58 424 5556677', name: 'Luisa' }),
          ],
        },
        { birthDate: MINOR },
      ),
    );
    expect(r).toMatchObject({
      ok: true,
      kind: 'RESPONSIBLE',
      destination: '584245556677',
      responsiblePartyId: 'r3',
    });
  });

  it('un menor sin responsable con ese contacto: 422 (nunca el email o el móvil de su ficha)', () => {
    expect(
      resolvePrescriptionCopyRecipient(input({}, { birthDate: MINOR })),
    ).toEqual({ ok: false, reason: PRESCRIPTION_COPY_MINOR_NO_EMAIL_MESSAGE });
    expect(
      resolvePrescriptionCopyRecipient(
        input({ channel: 'WHATSAPP' }, { birthDate: MINOR }),
      ),
    ).toEqual({
      ok: false,
      reason: PRESCRIPTION_COPY_MINOR_NO_WHATSAPP_MESSAGE,
    });
  });
});
