import {
  decideAnamnesisWithReminder,
  type AnamnesisReminderFacts,
} from './anamnesis-reminder-eligibility';

// DX-290: el criterio «nuevo o caducada» con el que el recordatorio lleva el
// enlace. La vigencia es la de la clínica (DX-247) y se mira el día civil de
// la CITA en la zona de su sede.
const CARACAS = 'America/Caracas';

function facts(
  over: Partial<AnamnesisReminderFacts> = {},
): AnamnesisReminderFacts {
  return {
    settingEnabled: true,
    patientArchived: false,
    awaitingReview: false,
    liveLink: false,
    lastReviewedAt: null,
    validityMonths: 12,
    appointmentDay: '2026-11-20',
    timeZone: CARACAS,
    sensitiveHealthGranted: true,
    hasPrivacyPolicy: true,
    ...over,
  };
}

describe('decideAnamnesisWithReminder (DX-290)', () => {
  it('paciente nuevo (sin anamnesis): lleva el enlace', () => {
    expect(decideAnamnesisWithReminder(facts())).toEqual({
      send: true,
      status: 'MISSING',
    });
  });

  it('anamnesis de hace 3 meses con vigencia de 12: no lo lleva', () => {
    expect(
      decideAnamnesisWithReminder(
        facts({ lastReviewedAt: new Date('2026-08-20T15:00:00Z') }),
      ),
    ).toEqual({ send: false, reason: 'CURRENT' });
  });

  it('anamnesis de hace 13 meses: caducada, lleva el enlace', () => {
    expect(
      decideAnamnesisWithReminder(
        facts({ lastReviewedAt: new Date('2025-10-15T15:00:00Z') }),
      ),
    ).toEqual({ send: true, status: 'EXPIRED' });
  });

  it('caduca el mismo día de la cita (día civil de la sede, no la hora)', () => {
    // Revisada el 20-11-2025 a las 20:00 en Caracas (00:00 UTC del 21):
    // vence el 20-11-2026 en Caracas, el día de la cita.
    const reviewed = new Date('2025-11-21T00:00:00Z');
    expect(
      decideAnamnesisWithReminder(facts({ lastReviewedAt: reviewed })),
    ).toEqual({ send: true, status: 'EXPIRED' });
    // La víspera aún vale.
    expect(
      decideAnamnesisWithReminder(
        facts({ lastReviewedAt: reviewed, appointmentDay: '2026-11-19' }),
      ),
    ).toEqual({ send: false, reason: 'CURRENT' });
  });

  it('respeta la vigencia de la clínica (6 meses)', () => {
    expect(
      decideAnamnesisWithReminder(
        facts({
          lastReviewedAt: new Date('2026-04-01T15:00:00Z'),
          validityMonths: 6,
        }),
      ),
    ).toEqual({ send: true, status: 'EXPIRED' });
  });

  it('con el ajuste de la sede apagado, nunca', () => {
    expect(
      decideAnamnesisWithReminder(facts({ settingEnabled: false })),
    ).toEqual({ send: false, reason: 'DISABLED' });
  });

  it('un paciente archivado no recibe enlace (DX-461)', () => {
    expect(
      decideAnamnesisWithReminder(facts({ patientArchived: true })),
    ).toEqual({ send: false, reason: 'ARCHIVED' });
  });

  it('con respuestas por revisar no pide otra', () => {
    expect(
      decideAnamnesisWithReminder(facts({ awaitingReview: true })),
    ).toEqual({ send: false, reason: 'AWAITING_REVIEW' });
  });

  it('con un enlace vivo (de un recordatorio anterior o de recepción) no emite otro', () => {
    expect(decideAnamnesisWithReminder(facts({ liveLink: true }))).toEqual({
      send: false,
      reason: 'LIVE_LINK',
    });
    // Vigente manda antes: no hay nada que recordar.
    expect(
      decideAnamnesisWithReminder(
        facts({
          liveLink: true,
          lastReviewedAt: new Date('2026-08-20T15:00:00Z'),
        }),
      ),
    ).toEqual({ send: false, reason: 'CURRENT' });
  });

  it('sin autorización: solo si la clínica tiene política para pedirla', () => {
    expect(
      decideAnamnesisWithReminder(
        facts({ sensitiveHealthGranted: false, hasPrivacyPolicy: true }),
      ),
    ).toEqual({ send: true, status: 'MISSING' });
    expect(
      decideAnamnesisWithReminder(
        facts({ sensitiveHealthGranted: false, hasPrivacyPolicy: false }),
      ),
    ).toEqual({ send: false, reason: 'NO_POLICY' });
  });
});
