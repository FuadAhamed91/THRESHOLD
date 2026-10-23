/**
 * Caregiver alert workflow (local demo). No SMS, push notification or Ring
 * device action is sent from this app; every step is recorded locally with a
 * timestamp so the hand-off is auditable.
 */
export type CaregiverStatus = 'idle' | 'pending' | 'reviewing' | 'confirmed' | 'dismissed' | 'resolved';

export interface CaregiverLogEntry {
  readonly at: string;
  readonly action: string;
  readonly detail: string;
}

export interface CaregiverState {
  readonly status: CaregiverStatus;
  readonly raisedAt: string | null;
  readonly reason: string | null;
  readonly log: CaregiverLogEntry[];
}

export const INITIAL_CAREGIVER: CaregiverState = { status: 'idle', raisedAt: null, reason: null, log: [] };

const entry = (action: string, detail: string): CaregiverLogEntry => ({ at: new Date().toISOString(), action, detail });

export function raise(state: CaregiverState, reason: string): CaregiverState {
  if (state.status === 'pending' || state.status === 'reviewing' || state.status === 'confirmed') return state;
  return { status: 'pending', raisedAt: new Date().toISOString(), reason, log: [...state.log, entry('Alert raised', reason)] };
}

export function transition(state: CaregiverState, action: 'review' | 'confirm' | 'dismiss' | 'resolve', detail = ''): CaregiverState {
  const next: Record<typeof action, CaregiverStatus> = { review: 'reviewing', confirm: 'confirmed', dismiss: 'dismissed', resolve: 'resolved' };
  const label: Record<typeof action, string> = {
    review: 'Event reviewed',
    confirm: 'Obstruction confirmed',
    dismiss: 'Alert dismissed',
    resolve: 'Resolution recorded',
  };
  return { ...state, status: next[action], log: [...state.log, entry(label[action], detail)] };
}
