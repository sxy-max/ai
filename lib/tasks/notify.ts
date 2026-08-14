/** 通知（PRD §65）：任务完成/失败写入 notifications 表，前端轮询/SSE 展示。 */

import { query } from "../db/pool";
import type { TaskRow } from "./types";

export type NotificationRow = {
  id: string;
  user_id: string;
  title: string;
  body: string;
  type: string;
  task_id: string | null;
  read: boolean;
  created_at: Date;
};

export async function createNotification(input: {
  userId: string;
  title: string;
  body: string;
  type?: string;
  taskId?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO notifications (user_id, title, body, type, task_id) VALUES ($1, $2, $3, $4, $5)`,
    [input.userId, input.title, input.body, input.type || "task", input.taskId ?? null]
  );
}

export async function notifyTaskFinished(task: TaskRow, success: boolean, summary?: string) {
  const title = success ? "任务已完成" : "任务失败";
  const body = success
    ? `「${task.title}」${summary ? `：${summary.slice(0, 80)}` : ""}`
    : `「${task.title}」：${(task.error || "执行出错").slice(0, 120)}`;
  await createNotification({ userId: task.user_id, title, body, taskId: task.id });
}

export async function listNotifications(userId: string, limit = 30): Promise<NotificationRow[]> {
  const result = await query<NotificationRow>(
    "SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
    [userId, limit]
  );
  return result.rows;
}

export async function markNotificationsRead(userId: string, ids?: string[]) {
  if (ids?.length) {
    await query("UPDATE notifications SET read = true WHERE user_id = $1 AND id = ANY($2::uuid[])", [userId, ids]);
  } else {
    await query("UPDATE notifications SET read = true WHERE user_id = $1", [userId]);
  }
}
