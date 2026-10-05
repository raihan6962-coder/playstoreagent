/** Shared storage paths for the automation layer (kept cycle-free). */
export const TASKS_PATH = "config/tasks.json";

export function taskEmailLogPath(taskId: string): string {
  return `emails/${taskId}.json`;
}
