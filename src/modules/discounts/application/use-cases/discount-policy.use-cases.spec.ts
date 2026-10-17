import { ClinicRole } from '@prisma/client';
import type { DiscountPolicyRules } from '../../domain/discount-policy';
import type {
  DiscountPolicyRepository,
  StoredDiscountPolicy,
} from '../../domain/ports/discount-policy-repository.port';
import {
  GetDiscountPolicyUseCase,
  UpdateDiscountPolicyUseCase,
} from './discount-policy.use-cases';

class FakeRepo implements DiscountPolicyRepository {
  stored: StoredDiscountPolicy | null = null;
  find() {
    return Promise.resolve(this.stored);
  }
  save(rules: DiscountPolicyRules, updatedById: string) {
    this.stored = { ...rules, updatedById, updatedAt: new Date(0) };
    return Promise.resolve(this.stored);
  }
}

describe('política de descuentos: casos de uso (DX-204)', () => {
  it('sin fila guardada devuelve la política por defecto', async () => {
    const view = await new GetDiscountPolicyUseCase(new FakeRepo()).execute();
    expect(view).toEqual({
      maxPercentByRole: { ADMIN: 100, DENTIST: 10, ASSISTANT: 0, RECEPTION: 0 },
      reasonRequiredAbovePercent: 10,
      isDefault: true,
      updatedAt: null,
      updatedById: null,
    });
  });

  it('guarda la política de la clínica con su autor y la devuelve', async () => {
    const repo = new FakeRepo();
    const rules = {
      maxPercentByRole: {
        [ClinicRole.ADMIN]: 50,
        [ClinicRole.DENTIST]: 15,
        [ClinicRole.ASSISTANT]: 5,
        [ClinicRole.RECEPTION]: 0,
      },
      reasonRequiredAbovePercent: 5,
    };
    await new UpdateDiscountPolicyUseCase(repo).execute(rules, 'admin-1');
    const view = await new GetDiscountPolicyUseCase(repo).execute();
    expect(view).toMatchObject({
      ...rules,
      isDefault: false,
      updatedById: 'admin-1',
    });
  });
});
