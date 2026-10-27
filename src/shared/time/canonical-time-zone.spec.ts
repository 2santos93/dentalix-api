import { canonicalTimeZoneName } from './canonical-time-zone';

describe('canonicalTimeZoneName', () => {
  it.each([
    ['asia/kolkata', 'Asia/Kolkata'],
    ['asia/calcutta', 'Asia/Calcutta'],
    ['europe/kyiv', 'Europe/Kyiv'],
    ['utc', 'UTC'],
    ['etc/utc', 'Etc/UTC'],
    ['america/port-au-prince', 'America/Port-au-Prince'],
    ['ASIA/TOKYO', 'Asia/Tokyo'],
    ['  Asia/Tokyo  ', 'Asia/Tokyo'],
  ])('canonicalTimeZoneName keeps links: %s → %s', (raw, expected) => {
    expect(canonicalTimeZoneName(raw)).toBe(expected);
  });

  it.each(['Mars/Olympus', '', '   ', null, undefined])('rejects %p', (raw) => {
    expect(canonicalTimeZoneName(raw)).toBeNull();
  });

  it('never calls resolvedOptions', () => {
    const spy = jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions');
    try {
      canonicalTimeZoneName('asia/kolkata');
      canonicalTimeZoneName('Mars/Olympus');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
