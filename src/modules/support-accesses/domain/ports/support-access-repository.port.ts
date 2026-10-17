import type { SupportAccess, SupportAccessCursor } from '../support-access';

export const SUPPORT_ACCESS_REPOSITORY = Symbol('SUPPORT_ACCESS_REPOSITORY');

export interface SupportAccessRepository {
  /**
   * Accesos a la clínica del contexto (RLS), más reciente primero, a partir
   * de `after` (excluido). Devuelve como mucho `take` filas.
   */
  list(
    take: number,
    after: SupportAccessCursor | null,
  ): Promise<SupportAccess[]>;
}
