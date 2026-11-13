import type { ConfigSnapshot } from '../../audit/domain/config-audit';
import type { RecallTypeView } from './recall.entity';

/**
 * DX-015-bis (D14): lo que la auditoría guarda de un tipo de recall (todo es
 * configuración). Los disparadores van en su propio evento
 * (`RECALL_TYPE_TRIGGERS_UPDATED`, con los ids de antes y de después).
 */
export function recallTypeSnapshot(type: RecallTypeView): ConfigSnapshot {
  return {
    name: type.name,
    defaultIntervalMonths: type.defaultIntervalMonths,
    active: type.active,
    sortOrder: type.sortOrder,
    exclusionGroup: type.exclusionGroup,
    appointmentTypeId: type.appointmentTypeId,
  };
}
