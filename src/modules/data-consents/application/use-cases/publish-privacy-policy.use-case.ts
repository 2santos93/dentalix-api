import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PRIVACY_POLICY_REPOSITORY } from '../../domain/ports/privacy-policy-repository.port';
import type { PrivacyPolicyRepository } from '../../domain/ports/privacy-policy-repository.port';
import type {
  PrivacyPolicyContent,
  PrivacyPolicyVersion,
} from '../../domain/entities/privacy-policy.entity';
import {
  normalizePolicyContent,
  policyContentHash,
} from '../../domain/privacy-policy-content';

export const EMPTY_POLICY_TEXT_MESSAGE =
  'Todos los textos de la política son obligatorios.';

@Injectable()
export class PublishPrivacyPolicyUseCase {
  constructor(
    @Inject(PRIVACY_POLICY_REPOSITORY)
    private readonly repo: PrivacyPolicyRepository,
  ) {}

  /**
   * Publica una versión NUEVA. No hay borradores ni edición: lo publicado es
   * lo que el paciente acepta, así que se fija (hash incluido) al publicarlo.
   */
  async execute(
    content: PrivacyPolicyContent,
    publishedById: string,
  ): Promise<PrivacyPolicyVersion> {
    const normalized = normalizePolicyContent(content);
    if (Object.values(normalized).some((text) => text === '')) {
      throw new BadRequestException(EMPTY_POLICY_TEXT_MESSAGE);
    }
    return this.repo.publish({
      ...normalized,
      contentHash: policyContentHash(normalized),
      publishedById,
    });
  }
}
