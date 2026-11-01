import { TEST_AUDIT } from '../../audit/application/__fixtures__/test-audit-context';
import { sanitizeAuditMetadata } from '../../audit/domain/audit-metadata';
import { locationScheduleAuditEvent } from './location-schedule-audit';

const LOC = '0192f0a0-0000-7000-8000-0000000000aa';
const MON = { weekday: 1, startMinute: 480, endMinute: 720 };
const TUE = { weekday: 2, startMinute: 540, endMinute: 780 };

describe('locationScheduleAuditEvent (DX-360)', () => {
  it('tramos antes y después, en la sede del horario', () => {
    const event = locationScheduleAuditEvent(
      TEST_AUDIT,
      LOC,
      [MON],
      [TUE, MON],
    );
    expect(event).toMatchObject({
      action: 'UPDATE',
      resourceType: 'LOCATION_SCHEDULE',
      resourceId: LOC,
      locationId: LOC,
      metadata: {
        reason: 'LOCATION_SCHEDULE_REPLACED',
        scheduleChange: {
          before: [{ locationId: LOC, ...MON }],
          after: [
            { locationId: LOC, ...MON },
            { locationId: LOC, ...TUE },
          ],
        },
      },
    });
    expect(sanitizeAuditMetadata(event?.metadata)).toEqual(event?.metadata);
  });

  it('la misma semana (en otro orden) no deja evento', () => {
    expect(
      locationScheduleAuditEvent(TEST_AUDIT, LOC, [MON, TUE], [TUE, MON]),
    ).toBeNull();
  });
});
