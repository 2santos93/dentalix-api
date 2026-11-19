import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ClinicRole, ExtraPermission } from '@prisma/client';
import {
  professionalReportPeriod,
  professionalScopeOf,
} from './professional-report-scope';

const messages = { forbidden: 'rol', ownOnly: 'propio' };
const me = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';

describe('professionalScopeOf (DX-304)', () => {
  it('ADMIN ve toda la clínica y puede filtrar por cualquiera', () => {
    expect(
      professionalScopeOf(
        { userId: me, role: ClinicRole.ADMIN, permissions: [] },
        other,
        messages,
      ),
    ).toEqual({ professionalId: other, kind: 'CLINIC' });
  });

  it('FINANCIAL_REPORTS_VIEW (DX-090) también ve toda la clínica', () => {
    expect(
      professionalScopeOf(
        {
          userId: me,
          role: ClinicRole.RECEPTION,
          permissions: [ExtraPermission.FINANCIAL_REPORTS_VIEW],
        },
        undefined,
        messages,
      ),
    ).toEqual({ professionalId: undefined, kind: 'CLINIC' });
  });

  it('el DENTIST queda acotado a sí mismo aunque no lo pida', () => {
    expect(
      professionalScopeOf(
        { userId: me, role: ClinicRole.DENTIST, permissions: [] },
        undefined,
        messages,
      ),
    ).toEqual({ professionalId: me, kind: 'OWN' });
  });

  it('el DENTIST que pide a otro: 403', () => {
    expect(() =>
      professionalScopeOf(
        { userId: me, role: ClinicRole.DENTIST, permissions: [] },
        other,
        messages,
      ),
    ).toThrow(new ForbiddenException('propio'));
  });

  it.each([ClinicRole.RECEPTION, ClinicRole.ASSISTANT])('%s: 403', (role) => {
    expect(() =>
      professionalScopeOf(
        { userId: me, role, permissions: [] },
        undefined,
        messages,
      ),
    ).toThrow(new ForbiddenException('rol'));
  });
});

describe('professionalReportPeriod', () => {
  it('acepta 24 meses menos un día y rechaza 24 meses', () => {
    expect(professionalReportPeriod('2026-01-01', '2027-12-31')).toEqual({
      from: '2026-01-01',
      to: '2027-12-31',
    });
    expect(() => professionalReportPeriod('2026-01-01', '2028-01-01')).toThrow(
      BadRequestException,
    );
  });

  it('rechaza «hasta» anterior a «desde»', () => {
    expect(() => professionalReportPeriod('2026-02-01', '2026-01-31')).toThrow(
      BadRequestException,
    );
  });
});
