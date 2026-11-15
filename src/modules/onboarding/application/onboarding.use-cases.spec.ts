import {
  DismissOnboardingUseCase,
  GetOnboardingStatusUseCase,
} from './onboarding.use-cases';
import type { OnboardingRepository } from '../domain/ports/onboarding-repository.port';
import type { OnboardingFacts } from '../domain/onboarding-steps';

const FACTS: OnboardingFacts = {
  dismissedAt: null,
  done: {
    BUSINESS_HOURS: true,
    APPOINTMENT_TYPES: false,
    CATALOG_PRICES: false,
    STAFF: false,
    FIRST_APPOINTMENT: false,
    PATIENT_IMPORT: false,
  },
};

describe('casos de uso de la puesta en marcha (DX-020)', () => {
  it('el estado sale de una sola lectura del repositorio', async () => {
    const facts = jest.fn().mockResolvedValue(FACTS);
    const dismiss = jest.fn();
    const repo: OnboardingRepository = { facts, dismiss };
    const status = await new GetOnboardingStatusUseCase(repo).execute();
    expect(facts).toHaveBeenCalledTimes(1);
    expect(dismiss).not.toHaveBeenCalled();
    expect(status.completedCount).toBe(1);
  });

  it('descartar escribe y devuelve el estado ya descartado', async () => {
    const at = new Date('2026-12-26T12:00:00Z');
    const order: string[] = [];
    const repo: OnboardingRepository = {
      facts: jest.fn(() => {
        order.push('facts');
        return Promise.resolve({ ...FACTS, dismissedAt: at });
      }),
      dismiss: jest.fn(() => {
        order.push('dismiss');
        return Promise.resolve();
      }),
    };
    const status = await new DismissOnboardingUseCase(repo).execute();
    expect(order).toEqual(['dismiss', 'facts']);
    expect(status.dismissedAt).toBe(at);
  });
});
