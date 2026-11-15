import { Inject, Injectable } from '@nestjs/common';
import {
  computeOnboardingStatus,
  type OnboardingStatus,
} from '../domain/onboarding-steps';
import {
  ONBOARDING_REPOSITORY,
  type OnboardingRepository,
} from '../domain/ports/onboarding-repository.port';

/** DX-020: estado de la tarjeta «Pon en marcha tu clínica». */
@Injectable()
export class GetOnboardingStatusUseCase {
  constructor(
    @Inject(ONBOARDING_REPOSITORY)
    private readonly repository: OnboardingRepository,
  ) {}

  async execute(): Promise<OnboardingStatus> {
    return computeOnboardingStatus(await this.repository.facts());
  }
}

/** DX-020: el ADMIN descarta la tarjeta; devuelve el estado ya descartado. */
@Injectable()
export class DismissOnboardingUseCase {
  constructor(
    @Inject(ONBOARDING_REPOSITORY)
    private readonly repository: OnboardingRepository,
  ) {}

  async execute(): Promise<OnboardingStatus> {
    await this.repository.dismiss();
    return computeOnboardingStatus(await this.repository.facts());
  }
}
