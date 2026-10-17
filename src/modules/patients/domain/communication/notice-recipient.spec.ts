import {
  noticeRecipient,
  type NoticeRecipientInput,
  type NoticeResponsible,
} from './notice-recipient';

const TODAY = '2026-10-17';
const CHILD = new Date('2015-03-10T00:00:00.000Z');
const ADULT = new Date('1990-05-01T00:00:00.000Z');
/** 17 años en TODAY: menor en CO, adulto en ES. */
const SEVENTEEN = new Date('2009-03-01T00:00:00.000Z');

const mother: NoticeResponsible = {
  id: 'mother',
  name: '  María José Pérez ',
  email: 'maria@example.com',
  isPayer: false,
  receivesNotices: true,
  optedOut: false,
};
const father: NoticeResponsible = {
  id: 'father',
  name: 'Luis Pérez',
  email: 'luis@example.com',
  isPayer: true,
  receivesNotices: true,
  optedOut: false,
};

function input(over: Partial<NoticeRecipientInput> = {}): NoticeRecipientInput {
  return {
    patient: {
      firstName: 'Sofía Andrea',
      birthDate: CHILD,
      email: null,
      emergencyContactName: null,
    },
    responsibles: [mother],
    country: 'CO',
    today: TODAY,
    ...over,
  };
}

describe('noticeRecipient (DX-203: menores y pacientes sin email, al responsable)', () => {
  it('un menor sin email recibe sus avisos en el email del responsable', () => {
    expect(noticeRecipient(input())).toEqual({
      kind: 'RESPONSIBLE',
      name: 'María',
      email: 'maria@example.com',
      minor: true,
      responsiblePartyId: 'mother',
    });
  });

  it('un menor CON email también: van al responsable', () => {
    const r = noticeRecipient(
      input({
        patient: { ...input().patient, email: 'sofi@example.com' },
      }),
    );
    expect(r).toMatchObject({
      kind: 'RESPONSIBLE',
      email: 'maria@example.com',
    });
  });

  it('primero el pagador principal; quien no recibe avisos no cuenta', () => {
    expect(
      noticeRecipient(input({ responsibles: [mother, father] }))
        .responsiblePartyId,
    ).toBe('father');
    expect(
      noticeRecipient(
        input({
          responsibles: [mother, { ...father, receivesNotices: false }],
        }),
      ).responsiblePartyId,
    ).toBe('mother');
  });

  it('un adulto sin email: al responsable; con email, a él mismo', () => {
    const adult = { ...input().patient, birthDate: ADULT };
    expect(noticeRecipient(input({ patient: adult })).kind).toBe('RESPONSIBLE');
    expect(
      noticeRecipient(
        input({ patient: { ...adult, email: ' yo@example.com ' } }),
      ),
    ).toEqual({
      kind: 'PATIENT',
      name: 'Sofía',
      email: 'yo@example.com',
      minor: false,
      responsiblePartyId: null,
    });
  });

  it('por país: 17 años es menor en CO y adulto en ES', () => {
    const teen = {
      ...input().patient,
      birthDate: SEVENTEEN,
      email: 'teen@example.com',
    };
    expect(noticeRecipient(input({ patient: teen, country: 'CO' })).kind).toBe(
      'RESPONSIBLE',
    );
    expect(
      noticeRecipient(input({ patient: teen, country: 'ES' })),
    ).toMatchObject({
      kind: 'PATIENT',
      email: 'teen@example.com',
      minor: false,
    });
  });

  it('el responsable sin email: un menor va al email de la ficha saludándolo (DX-128)', () => {
    const r = noticeRecipient(
      input({
        patient: { ...input().patient, email: 'familia@example.com' },
        responsibles: [{ ...mother, email: null }],
      }),
    );
    expect(r).toEqual({
      kind: 'GUARDIAN',
      name: 'María',
      email: 'familia@example.com',
      minor: true,
      responsiblePartyId: 'mother',
    });
  });

  it('un menor sin responsables: al contacto principal o a su nombre', () => {
    expect(
      noticeRecipient(
        input({
          responsibles: [],
          patient: { ...input().patient, emergencyContactName: 'Luis Gómez' },
        }),
      ),
    ).toMatchObject({ kind: 'CONTACT', name: 'Luis', email: null });
    expect(noticeRecipient(input({ responsibles: [] }))).toMatchObject({
      kind: 'PATIENT',
      email: null,
      minor: true,
    });
  });

  it('automático: se respeta la baja del paciente responsable (DX-128)', () => {
    const optedOut = { ...father, optedOut: true };
    expect(
      noticeRecipient(
        input({ responsibles: [optedOut, mother], automatic: true }),
      ).responsiblePartyId,
    ).toBe('mother');
    // Un envío pedido por recepción (recibo) sí le llega.
    expect(
      noticeRecipient(input({ responsibles: [optedOut, mother] }))
        .responsiblePartyId,
    ).toBe('father');
  });

  it('sin fecha de nacimiento y con email: adulto, a él mismo', () => {
    expect(
      noticeRecipient(
        input({
          patient: {
            ...input().patient,
            birthDate: null,
            email: 'x@example.com',
          },
        }),
      ).kind,
    ).toBe('PATIENT');
  });
});
