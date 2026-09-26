// "Jump back in" / Resume recency list (FR: L14). Pure logic, no imports —
// unit-testable in node without dragging the store's fetch/WebSocket wiring
// along. One entry per task; the entry carries the subtask of that task's
// most recent session so Resume puts you back on exactly what you last
// tracked (a task-id-only list loses that).

export interface RecentEntry {
  task_id: string;
  /** Subtask of this task's latest session — null when the whole task was tracked. */
  subtask_id: string | null;
}

export const RECENT_LIMIT = 6;

/** Move `taskId` to the front with its newly tracked `subtaskId`, keeping the
 *  relative order of the other tasks. */
export function mergeRecent(existing: RecentEntry[], taskId: string, subtaskId: string | null): RecentEntry[] {
  return [{ task_id: taskId, subtask_id: subtaskId ?? null }, ...existing.filter((e) => e.task_id !== taskId)].slice(
    0,
    RECENT_LIMIT,
  );
}

/** Bootstrap payload → recency list. Reads the subtask-aware `recent` shape
 *  and falls back to the legacy task-id-only array (cached/older payload). */
export function recentFromBootstrap(b: any): RecentEntry[] {
  if (Array.isArray(b?.recent)) {
    return b.recent
      .filter((e: any) => e && typeof e.task_id === 'string')
      .map((e: any) => ({
        task_id: e.task_id as string,
        subtask_id: typeof e.subtask_id === 'string' ? (e.subtask_id as string) : null,
      }))
      .slice(0, RECENT_LIMIT);
  }
  if (Array.isArray(b?.recent_task_ids)) {
    return (b.recent_task_ids as unknown[])
      .filter((id): id is string => typeof id === 'string')
      .slice(0, RECENT_LIMIT)
      .map((task_id) => ({ task_id, subtask_id: null }));
  }
  return [];
}
