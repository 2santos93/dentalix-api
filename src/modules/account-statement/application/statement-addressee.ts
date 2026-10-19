import { noticeRecipient } from '../../patients/domain/communication/notice-recipient';
import { civilDateIn } from '../../../shared/time/civil-day';
import type { StatementAddressee } from '../domain/entities/account-statement.entity';
import type { StatementNoticeData } from '../domain/ports/statement-family-repository.port';

/**
 * Regla de destinatario de DX-203 aplicada al estado de cuenta (DX-011): el
 * de un menor o de un paciente sin email sale a nombre de su responsable que
 * recibe avisos (primero el pagador principal), tenga o no email: es un
 * documento que se imprime y se entrega en mano. Si no hay responsable, a
 * nombre del paciente.
 */
export function statementAddressee(
  patient: { firstName: string; lastName: string },
  notice: StatementNoticeData | null,
  now: Date,
): StatementAddressee {
  const self: StatementAddressee = {
    kind: 'PATIENT',
    name: `${patient.firstName} ${patient.lastName}`,
    email: notice?.patient.email?.trim() || null,
  };
  if (!notice) return self;
  const recipient = noticeRecipient({
    patient: notice.patient,
    responsibles: notice.responsibles,
    country: notice.location.country,
    today: civilDateIn(now, notice.location.timeZone),
  });
  const responsible = notice.responsibles.find(
    (r) => r.id === recipient.responsiblePartyId,
  );
  if (!responsible) return self;
  return {
    kind: 'RESPONSIBLE',
    name: responsible.name,
    email: responsible.email?.trim() || null,
  };
}
