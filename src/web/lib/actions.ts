// Shared task/project actions used by BOTH the sidebar tree and the Tasks view
// (audit precedent: timer-start logic was once triplicated with divergent bugs).
// Each helper toasts its own errors and applies server payloads locally.
import { store, pushToast } from './store';
import { api } from './api';
import { openPrompt } from '../components/PromptModal';
import { fmtTarget } from '../../shared/goals';

export async function addProject(): Promise<void> {
  // non-blocking modal instead of window.prompt
  const name = await openPrompt({ title: 'New project', placeholder: 'Project name', confirmText: 'Create' });
  if (!name?.trim()) return;
  try {
    const res = await api<{ project: any }>('/projects', { method: 'POST', body: { name: name.trim() } });
    store.upsertLocal('project', res.project);
    store.selectProject(res.project.id);
  } catch (e: any) {
    pushToast('error', e.message);
  }
}

export async function addTask(projectId: string): Promise<void> {
  const name = await openPrompt({ title: 'New task', placeholder: 'Task name', confirmText: 'Create' });
  if (!name?.trim()) return;
  try {
    const res = await api<{ task: any }>(`/projects/${projectId}/tasks`, {
      method: 'POST',
      body: { name: name.trim() },
    });
    store.upsertLocal('task', res.task);
    store.selectTask(res.task.id);
  } catch (e: any) {
    pushToast('error', e.message);
  }
}

export async function addSubtask(taskId: string): Promise<void> {
  const name = await openPrompt({ title: 'New subtask', placeholder: 'Subtask name', confirmText: 'Create' });
  if (!name?.trim()) return;
  try {
    const res = await api<{ subtask: any }>(`/tasks/${taskId}/subtasks`, {
      method: 'POST',
      body: { name: name.trim() },
    });
    store.upsertLocal('subtask', res.subtask);
  } catch (e: any) {
    pushToast('error', e.message);
  }
}

export async function toggleTaskDone(task: { id: string; done: 0 | 1 }): Promise<void> {
  try {
    const res = await api<{ task: any }>(`/tasks/${task.id}`, { method: 'PATCH', body: { done: !task.done } });
    store.upsertLocal('task', res.task);
    store.bumpReports();
  } catch (e: any) {
    pushToast('error', e.message);
  }
}

/** Subtask check toggling: immediate visual feedback; every rapid tap persists. */
export async function toggleSubtaskDone(sb: { id: string; done: 0 | 1 }): Promise<void> {
  store.upsertLocal('subtask', { ...sb, done: sb.done ? 0 : 1 });
  try {
    const res = await api<{ subtask: any }>(`/subtasks/${sb.id}`, { method: 'PATCH', body: { done: !sb.done } });
    store.upsertLocal('subtask', res.subtask);
  } catch (e: any) {
    pushToast('error', e.message);
    void store.refreshAll();
  }
}

/** Timer on a TASK: stop when it is the one running; otherwise start (the
 *  shared startTimer applies setRunning + setPomo and falls back to /switch). */
export async function toggleTaskTimer(taskId: string): Promise<void> {
  if (store.get().running?.task_id === taskId) {
    try {
      await api('/timer/stop', { method: 'POST' });
      store.setRunning(null);
    } catch (e: any) {
      pushToast('error', e.message);
    }
    return;
  }
  try {
    await store.startTimer(taskId);
  } catch (e: any) {
    pushToast('error', e.message);
  }
}

/** Timer on a SUBTASK: stop when that subtask is the one running; otherwise
 *  start (or switch to) a session attributed to it — same-task switches
 *  split the session server-side. */
export async function toggleSubtaskTimer(taskId: string, subtaskId: string): Promise<void> {
  if (store.get().running?.subtask_id === subtaskId) {
    try {
      await api('/timer/stop', { method: 'POST' });
      store.setRunning(null);
    } catch (e: any) {
      pushToast('error', e.message);
    }
    return;
  }
  try {
    await store.startTimer(taskId, subtaskId);
  } catch (e: any) {
    pushToast('error', e.message);
  }
}

/** Stop the active timer. Kept separate from resume so every caller can share
 *  the same authoritative stop/update behavior. */
export async function stopTimer(): Promise<void> {
  if (!store.get().running) return;
  try {
    await api('/timer/stop', { method: 'POST' });
    store.setRunning(null);
  } catch (e: any) {
    pushToast('error', e.message);
  }
}

/** Resume (R) when idle, stop the active timer when running. */
export async function toggleLastTask(): Promise<void> {
  if (store.get().running) {
    await stopTimer();
    return;
  }
  await resumeLastTask();
}

/** Resume the most recently tracked task — on its last-used subtask when the
 *  newest session for that task was attributed to one. A subtask deleted
 *  since falls back to the whole task. */ export async function resumeLastTask(): Promise<void> {
  const s = store.get();
  const last = s.recentEntries[0];
  const task = last ? s.tasks.find((t) => t.id === last.task_id) : null;
  if (!task) {
    pushToast('info', 'Nothing to resume yet — track something first');
    return;
  }
  const subtask = last?.subtask_id ? (s.subtasks.find((sb) => sb.id === last.subtask_id) ?? null) : null;
  const label = subtask ? `${task.name} ▸ ${subtask.name}` : task.name;
  try {
    await store.startTimer(task.id, subtask?.id ?? null);
    pushToast('info', `Resumed “${label}”`);
  } catch (e: any) {
    pushToast('error', e.message);
  }
}

// ---------- goals (v0.6.0) ----------

export interface GoalInput {
  name: string;
  period: 'day' | 'week' | 'month';
  direction: 'at_least' | 'at_most';
  target_minutes: number;
  scope: string[];
  ends_at: number | null;
}

export async function addGoal(input: GoalInput): Promise<void> {
  try {
    const res = await api<{ goal: any }>('/goals', { method: 'POST', body: input });
    store.upsertLocal('goal', res.goal);
  } catch (e: any) {
    pushToast('error', e.message);
  }
}

export async function updateGoal(id: string, patch: Partial<GoalInput> & { archived?: boolean }): Promise<void> {
  try {
    const res = await api<{ goal: any }>(`/goals/${id}`, { method: 'PATCH', body: patch });
    store.upsertLocal('goal', res.goal);
  } catch (e: any) {
    pushToast('error', e.message);
  }
}

/** Goals are referenced by nothing, so delete is not a tombstone — undo
 *  re-creates the goal from the row the DELETE returned (fresh id). */
export async function deleteGoalWithUndo(goal: any): Promise<void> {
  try {
    await api(`/goals/${goal.id}`, { method: 'DELETE' });
    pushToast('undo', `Goal “${goalLabel(goal)}” deleted — undo?`, async () => {
      await addGoal({
        name: goal.name,
        period: goal.period,
        direction: goal.direction,
        target_minutes: goal.target_minutes,
        scope: goal.scope,
        ends_at: goal.ends_at,
      });
    });
  } catch (e: any) {
    pushToast('error', e.message);
  }
}

/** Display label: the user's name, else the auto target phrase. */
function goalLabel(goal: any): string {
  return goal.name || fmtTarget(goal);
}
