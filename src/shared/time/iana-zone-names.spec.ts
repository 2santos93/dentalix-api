import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IANA_ZONE_NAMES } from './iana-zone-names';

describe('IANA_ZONE_NAMES', () => {
  it('JSON equals IANA_ZONE_NAMES', () => {
    const json: unknown = JSON.parse(
      readFileSync(
        join(__dirname, '../../../prisma/reference/iana-zone-names.json'),
        'utf8',
      ),
    );
    expect(json).toEqual([...IANA_ZONE_NAMES]);
  });

  it('contains every supportedValuesOf zone and Asia/Kolkata, UTC, Etc/UTC', () => {
    const missing = Intl.supportedValuesOf('timeZone').filter(
      (zone) => !IANA_ZONE_NAMES.includes(zone),
    );
    // Si falla: Node/ICU distinto del de la cabecera de iana-zone-names.ts.
    expect({
      hint: 'regenera con generate-iana-zone-names.ts: Node/ICU distinto del de la cabecera',
      missing,
    }).toEqual({
      hint: 'regenera con generate-iana-zone-names.ts: Node/ICU distinto del de la cabecera',
      missing: [],
    });
    for (const zone of ['Asia/Kolkata', 'UTC', 'Etc/UTC']) {
      expect(IANA_ZONE_NAMES).toContain(zone);
    }
  });

  it('sorted and unique', () => {
    expect([...IANA_ZONE_NAMES]).toEqual([...new Set(IANA_ZONE_NAMES)].sort());
  });
});
