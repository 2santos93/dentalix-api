import type { ConfigSnapshot } from '../../audit/domain/config-audit';
import type { Payer } from './entities/payer.entity';

/** DX-360: lo que la auditoría guarda de un pagador (nombre, tipo genérico, activo). */
export function payerSnapshot(payer: Payer): ConfigSnapshot {
  return { name: payer.name, type: payer.type, active: payer.active };
}
