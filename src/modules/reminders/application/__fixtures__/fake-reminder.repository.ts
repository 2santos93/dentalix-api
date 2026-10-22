import type {
  AppointmentReminderSkipReason,
  AppointmentReminderStatus,
} from '@prisma/client';
import type {
  AppointmentRemindersSnapshot,
  LocationReminderSettingsView,
  ReminderCandidate,
  ReminderClaim,
  ReminderRepository,
  ReminderSendContext,
} from '../../domain/ports/reminder-repository.port';
import type { ReminderSettingsInput } from '../../domain/reminder-lead-hours';

interface StoredReminder {
  id: string;
  appointmentId: string;
  leadHours: number;
  start: Date;
  status: AppointmentReminderStatus;
  skipReason: AppointmentReminderSkipReason | null;
  outboundMessageId: string | null;
  sentAt: Date | null;
  failureReason?: string | null;
}

/** Repositorio en memoria para los unit tests de los casos de uso (DX-026). */
export class FakeReminderRepository implements ReminderRepository {
  readonly locations = new Map<string, LocationReminderSettingsView>();
  readonly contexts = new Map<string, ReminderSendContext>();
  readonly reminders: StoredReminder[] = [];
  readonly queuedEmails = new Set<string>();
  candidates: Record<string, ReminderCandidate[]> = {};
  snapshot: AppointmentRemindersSnapshot | null = null;
  private seq = 0;

  listSettings(): Promise<LocationReminderSettingsView[]> {
    return Promise.resolve([...this.locations.values()]);
  }

  saveSettings(
    locationId: string,
    input: ReminderSettingsInput,
  ): Promise<LocationReminderSettingsView | null> {
    const current = this.locations.get(locationId);
    if (!current) return Promise.resolve(null);
    const saved = { ...current, ...input, updatedAt: new Date() };
    this.locations.set(locationId, saved);
    return Promise.resolve(saved);
  }

  tenantIds(): Promise<string[]> {
    return Promise.resolve(Object.keys(this.candidates));
  }

  dueCandidates(tenantId: string): Promise<ReminderCandidate[]> {
    return Promise.resolve(this.candidates[tenantId] ?? []);
  }

  loadSendContext(appointmentId: string): Promise<ReminderSendContext | null> {
    return Promise.resolve(this.contexts.get(appointmentId) ?? null);
  }

  private find(appointmentId: string, leadHours: number, start: Date) {
    return this.reminders.find(
      (r) =>
        r.appointmentId === appointmentId &&
        r.leadHours === leadHours &&
        r.start.getTime() === start.getTime(),
    );
  }

  recordSkipped(
    appointmentId: string,
    leadHours: number,
    start: Date,
    reason: AppointmentReminderSkipReason,
  ): Promise<boolean> {
    const existing = this.find(appointmentId, leadHours, start);
    if (existing) {
      if (existing.status !== 'SENDING' || existing.outboundMessageId) {
        return Promise.resolve(false);
      }
      existing.status = 'SKIPPED';
      existing.skipReason = reason;
      return Promise.resolve(true);
    }
    this.reminders.push({
      id: `r${++this.seq}`,
      appointmentId,
      leadHours,
      start,
      status: 'SKIPPED',
      skipReason: reason,
      outboundMessageId: null,
      sentAt: null,
    });
    return Promise.resolve(true);
  }

  claim(
    appointmentId: string,
    leadHours: number,
    start: Date,
  ): Promise<ReminderClaim> {
    let row = this.find(appointmentId, leadHours, start);
    if (!row) {
      row = {
        id: `r${++this.seq}`,
        appointmentId,
        leadHours,
        start,
        status: 'SENDING',
        skipReason: null,
        outboundMessageId: null,
        sentAt: null,
      };
      this.reminders.push(row);
    }
    return Promise.resolve({
      id: row.id,
      status: row.status,
      outboundMessageId: row.outboundMessageId,
    });
  }

  attachOutbound(reminderId: string, outboundMessageId: string): Promise<void> {
    const row = this.reminders.find((r) => r.id === reminderId);
    if (row && !row.outboundMessageId)
      row.outboundMessageId = outboundMessageId;
    return Promise.resolve();
  }

  emailQueuedFor(outboundMessageId: string): Promise<boolean> {
    return Promise.resolve(this.queuedEmails.has(outboundMessageId));
  }

  markSent(reminderId: string, sentAt: Date): Promise<void> {
    const row = this.reminders.find((r) => r.id === reminderId);
    if (row?.status === 'SENDING') {
      row.status = 'SENT';
      row.sentAt = sentAt;
    }
    return Promise.resolve();
  }

  markFailed(
    appointmentId: string,
    leadHours: number,
    start: Date,
    errorCode: string,
    now: Date,
  ): Promise<void> {
    const row = this.find(appointmentId, leadHours, start);
    if (row?.status !== 'SENDING') return Promise.resolve();
    if (row.outboundMessageId && this.queuedEmails.has(row.outboundMessageId)) {
      row.status = 'SENT';
      row.sentAt = now;
    } else {
      row.status = 'FAILED';
      row.failureReason = errorCode;
    }
    return Promise.resolve();
  }

  findAppointmentReminders(): Promise<AppointmentRemindersSnapshot | null> {
    return Promise.resolve(this.snapshot);
  }
}
