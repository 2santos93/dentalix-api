import { buildFollowUpReport } from './quote-follow-up-report';

describe('buildFollowUpReport (DX-561, D5)', () => {
  it('por paso y en total: enviados, abiertos, aceptados en 14 días y las tasas; omisiones por motivo', () => {
    const report = buildFollowUpReport([
      {
        step: 1,
        status: 'SENT',
        reason: null,
        opened: true,
        acceptedWithin14Days: true,
      },
      {
        step: 1,
        status: 'SENT',
        reason: null,
        opened: true,
        acceptedWithin14Days: false,
      },
      {
        step: 1,
        status: 'SENT',
        reason: null,
        opened: false,
        acceptedWithin14Days: false,
      },
      {
        step: 2,
        status: 'SENT',
        reason: null,
        opened: false,
        acceptedWithin14Days: false,
      },
      {
        step: 2,
        status: 'SKIPPED',
        reason: 'OPTED_OUT',
        opened: false,
        acceptedWithin14Days: false,
      },
      {
        step: 3,
        status: 'SKIPPED',
        reason: 'OPTED_OUT',
        opened: false,
        acceptedWithin14Days: false,
      },
      {
        step: 1,
        status: 'SKIPPED',
        reason: 'SUPERSEDED',
        opened: false,
        acceptedWithin14Days: false,
      },
    ]);
    expect(report.steps[0]).toEqual({
      step: 1,
      sent: 3,
      opened: 2,
      acceptedWithin14Days: 1,
      openRate: 66.7,
      acceptanceRate: 33.3,
    });
    expect(report.steps[2]).toEqual({
      step: 3,
      sent: 0,
      opened: 0,
      acceptedWithin14Days: 0,
      openRate: null,
      acceptanceRate: null,
    });
    expect(report.total).toMatchObject({
      step: null,
      sent: 4,
      opened: 2,
      acceptedWithin14Days: 1,
      acceptanceRate: 25,
    });
    expect(report.skipped).toEqual([
      { reason: 'OPTED_OUT', count: 2 },
      { reason: 'SUPERSEDED', count: 1 },
    ]);
  });
});
