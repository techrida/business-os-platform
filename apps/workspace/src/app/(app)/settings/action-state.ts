// What a Server Action hands back to a form. A plain module (no 'use server') because a 'use server'
// file may only export async functions, and Client Components need the type and the initial value.
export interface ActionState {
  status: 'idle' | 'ok' | 'error';
  message: string;
  /**
   * The submitted values, returned on an error. React resets an uncontrolled form after its action
   * finishes, so without these the admin would retype everything after a rejected save. Lists are
   * comma-joined.
   */
  fields?: Record<string, string>;
  fieldErrors?: Record<string, string>;
}

export const IDLE: ActionState = { status: 'idle', message: '' };

export const ok = (message: string): ActionState => ({ status: 'ok', message });
export const fail = (message: string, fields?: Record<string, string>): ActionState =>
  fields ? { status: 'error', message, fields } : { status: 'error', message };
