import { emailReminderBlocker } from './reminder-eligibility';

const OPT_OUT = new Date('2026-10-17T10:00:00Z');

describe('emailReminderBlocker (DX-128, regla de elegibilidad)', () => {
  const base = {
    contactChannel: 'EMAIL' as const,
    reminderOptOutAt: null,
    email: 'ana@example.com',
  };

  it('canal EMAIL, sin baja y con email: sale por email', () => {
    expect(emailReminderBlocker(base)).toBeNull();
  });

  it('una baja gana a todo lo demás, en cualquier canal', () => {
    for (const contactChannel of ['EMAIL', 'WHATSAPP', 'NONE'] as const) {
      expect(
        emailReminderBlocker({
          ...base,
          contactChannel,
          reminderOptOutAt: OPT_OUT,
        }),
      ).toBe('OPTED_OUT');
    }
  });

  it('canal NONE: no se le envía nada automático', () => {
    expect(emailReminderBlocker({ ...base, contactChannel: 'NONE' })).toBe(
      'CHANNEL_NONE',
    );
  });

  it('canal WHATSAPP: no recibe el email automático aunque tenga email', () => {
    expect(emailReminderBlocker({ ...base, contactChannel: 'WHATSAPP' })).toBe(
      'CHANNEL_WHATSAPP',
    );
  });

  it.each([null, '', '   '])(
    'canal EMAIL sin email (%j): NO_EMAIL',
    (email) => {
      expect(emailReminderBlocker({ ...base, email })).toBe('NO_EMAIL');
    },
  );
});
