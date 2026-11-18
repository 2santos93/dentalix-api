import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  DEFAULT_SETTINGS,
  FROM_HOUR_MESSAGE,
  OFFSET_RANGE_MESSAGE,
  OFFSETS_COUNT_MESSAGE,
  OFFSETS_ORDER_MESSAGE,
  quoteFollowUpSettingsAuditEvent,
  quoteFollowUpSettingsError,
  UNTIL_HOUR_MESSAGE,
  WINDOW_ORDER_MESSAGE,
} from './quote-follow-up-settings';

const ok = {
  enabled: true,
  offsetsDays: [3, 10, 21],
  sendFromHour: 9,
  sendUntilHour: 19,
};

describe('quoteFollowUpSettingsError (DX-561)', () => {
  it('acepta de 1 a 3 avisos crecientes y la franja 0–24', () => {
    expect(quoteFollowUpSettingsError(ok)).toBe(null);
    expect(quoteFollowUpSettingsError({ ...ok, offsetsDays: [90] })).toBe(null);
    expect(
      quoteFollowUpSettingsError({ ...ok, sendFromHour: 0, sendUntilHour: 24 }),
    ).toBe(null);
  });

  it.each([
    [[], OFFSETS_COUNT_MESSAGE],
    [[1, 2, 3, 4], OFFSETS_COUNT_MESSAGE],
    [[0], OFFSET_RANGE_MESSAGE],
    [[91], OFFSET_RANGE_MESSAGE],
    [[2.5], OFFSET_RANGE_MESSAGE],
    [[10, 3], OFFSETS_ORDER_MESSAGE],
    [[3, 3], OFFSETS_ORDER_MESSAGE],
  ])('días %j → %s', (offsetsDays, message) => {
    expect(quoteFollowUpSettingsError({ ...ok, offsetsDays })).toBe(message);
  });

  it('la franja: horas enteras y el final después del inicio', () => {
    expect(quoteFollowUpSettingsError({ ...ok, sendFromHour: 24 })).toBe(
      FROM_HOUR_MESSAGE,
    );
    expect(quoteFollowUpSettingsError({ ...ok, sendFromHour: -1 })).toBe(
      FROM_HOUR_MESSAGE,
    );
    expect(quoteFollowUpSettingsError({ ...ok, sendUntilHour: 0 })).toBe(
      UNTIL_HOUR_MESSAGE,
    );
    expect(quoteFollowUpSettingsError({ ...ok, sendUntilHour: 25 })).toBe(
      UNTIL_HOUR_MESSAGE,
    );
    expect(
      quoteFollowUpSettingsError({ ...ok, sendFromHour: 19, sendUntilHour: 9 }),
    ).toBe(WINDOW_ORDER_MESSAGE);
    expect(
      quoteFollowUpSettingsError({ ...ok, sendFromHour: 9, sendUntilHour: 9 }),
    ).toBe(WINDOW_ORDER_MESSAGE);
  });
});

describe('quoteFollowUpSettingsAuditEvent', () => {
  const ctx = {
    tenantId: 't1',
    locationId: null,
    actor: { userId: 'u1', role: 'ADMIN' },
    requestId: 'r1',
    ip: null,
    userAgent: null,
  } as unknown as AuditRequestContext;

  it('sin cambios no hay evento; con cambios, el antes y el después en la sede', () => {
    expect(
      quoteFollowUpSettingsAuditEvent(ctx, 'loc', DEFAULT_SETTINGS, {
        ...DEFAULT_SETTINGS,
      }),
    ).toBe(null);
    const event = quoteFollowUpSettingsAuditEvent(
      ctx,
      'loc',
      DEFAULT_SETTINGS,
      ok,
    );
    expect(event).toMatchObject({
      action: 'UPDATE',
      resourceType: 'CLINIC_SETTINGS',
      resourceId: 'loc',
      locationId: 'loc',
      metadata: { reason: 'QUOTE_FOLLOW_UP_SETTINGS_UPDATED' },
    });
  });
});
