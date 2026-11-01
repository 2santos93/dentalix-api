import { Inject, Injectable } from '@nestjs/common';
import { AUTH_REPOSITORY } from '../../domain/ports/auth-repository.port';
import type { AuthRepository } from '../../domain/ports/auth-repository.port';
import {
  normalizeSubdomain,
  SUBDOMAIN_MAX_LENGTH,
  subdomainRuleVerdict,
} from '../../../../shared/tenancy/subdomain-rules';

export const SUBDOMAIN_AVAILABILITY = [
  'available',
  'taken',
  'invalid',
  'reserved',
] as const;
export type SubdomainAvailability = (typeof SUBDOMAIN_AVAILABILITY)[number];

/**
 * ¿Se puede registrar esta dirección web? Para la línea de estado del
 * registro mientras se escribe. Con las MISMAS reglas que el registro
 * (`shared/tenancy/subdomain-rules.ts` + clínica que la ocupa, también dada
 * de baja), así que «available» es lo que el envío aceptará salvo que otra
 * clínica la tome antes (el 409 del envío lo sigue cubriendo).
 *
 * Enumeración: solo dice libre/ocupada, que ya es público (la dirección ES el
 * host de la clínica: abrirla muestra su marca, y el 409 del registro lo dice
 * igual). No dice nada de la clínica (ni id ni nombre) ni de registros
 * pendientes, y no toca la BD si la forma no vale. El ritmo lo limita la
 * política `subdomain-check` (por IP).
 */
@Injectable()
export class CheckSubdomainAvailabilityUseCase {
  constructor(@Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository) {}

  async execute(
    raw: string,
  ): Promise<{ subdomain: string; status: SubdomainAvailability }> {
    // Tope antes de normalizar: una ruta de kilobytes no se procesa.
    const subdomain =
      raw.length > SUBDOMAIN_MAX_LENGTH * 2 ? '' : normalizeSubdomain(raw);
    const verdict = subdomainRuleVerdict(subdomain);
    if (verdict !== 'ok') return { subdomain, status: verdict };
    const taken = await this.repo.findTenantBySubdomain(subdomain);
    return { subdomain, status: taken ? 'taken' : 'available' };
  }
}
