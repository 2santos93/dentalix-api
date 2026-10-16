import { Inject, Injectable } from '@nestjs/common';
import { PRIVACY_POLICY_REPOSITORY } from '../../domain/ports/privacy-policy-repository.port';
import type { PrivacyPolicyRepository } from '../../domain/ports/privacy-policy-repository.port';
import type { PrivacyPolicies } from '../../domain/entities/privacy-policy.entity';

@Injectable()
export class GetPrivacyPoliciesUseCase {
  constructor(
    @Inject(PRIVACY_POLICY_REPOSITORY)
    private readonly repo: PrivacyPolicyRepository,
  ) {}

  /** Vigente = la de mayor versión; `null` si la clínica aún no publicó ninguna. */
  async execute(): Promise<PrivacyPolicies> {
    const history = await this.repo.list();
    return { current: history[0] ?? null, history };
  }
}
