import { ClinicRole, ExtraPermission } from '@prisma/client';
import {
  EXTRA_PERMISSIONS,
  effectivePermissions,
  normalizeExtraPermissions,
  roleBasePermissions,
} from './extra-permissions';

const { PAYMENT_REGISTER, FINANCIAL_REPORTS_VIEW } = ExtraPermission;

describe('DX-090 — catálogo de permisos extra', () => {
  it('el catálogo es cerrado: exactamente los dos del enum', () => {
    expect([...EXTRA_PERMISSIONS].sort()).toEqual(
      Object.values(ExtraPermission).sort(),
    );
    expect(EXTRA_PERMISSIONS).toHaveLength(2);
  });

  it('de serie: ADMIN todo, RECEPTION cobra, DENTIST y ASSISTANT nada', () => {
    expect(roleBasePermissions(ClinicRole.ADMIN)).toEqual([
      PAYMENT_REGISTER,
      FINANCIAL_REPORTS_VIEW,
    ]);
    expect(roleBasePermissions(ClinicRole.RECEPTION)).toEqual([
      PAYMENT_REGISTER,
    ]);
    expect(roleBasePermissions(ClinicRole.DENTIST)).toEqual([]);
    expect(roleBasePermissions(ClinicRole.ASSISTANT)).toEqual([]);
  });

  it('efectivos = serie ∪ extra, sin duplicados y en el orden del catálogo', () => {
    expect(
      effectivePermissions(ClinicRole.ASSISTANT, [
        FINANCIAL_REPORTS_VIEW,
        PAYMENT_REGISTER,
      ]),
    ).toEqual([PAYMENT_REGISTER, FINANCIAL_REPORTS_VIEW]);
    expect(
      effectivePermissions(ClinicRole.RECEPTION, [PAYMENT_REGISTER]),
    ).toEqual([PAYMENT_REGISTER]);
    expect(effectivePermissions(ClinicRole.DENTIST, [])).toEqual([]);
  });

  it('normalizar quita duplicados y ordena', () => {
    expect(
      normalizeExtraPermissions([
        FINANCIAL_REPORTS_VIEW,
        PAYMENT_REGISTER,
        FINANCIAL_REPORTS_VIEW,
      ]),
    ).toEqual([PAYMENT_REGISTER, FINANCIAL_REPORTS_VIEW]);
  });
});
