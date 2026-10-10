/**
 * Fire-and-forget Telegram notifications for the automation lifecycle.
 * Never throws — a dead bot must not take a run, a task or an email chain
 * down with it. Token/chat come from env so nothing sensitive lands in git.
 */

const TIMEOUT_MS = 8_000;

export async function notifyTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Plain text: task keywords and error strings are user-controlled, so
      // no parse mode means nothing to escape.
      body: JSON.stringify({ chat_id: chatId, text }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) console.error(`telegram notify failed (${response.status})`);
  } catch (error) {
    console.error("telegram notify failed", error);
  }
}

/** Format an epoch ms as a compact local timestamp for notifications. */
export function notifyTime(at: number): string {
  return new Date(at).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    // Vercel runs in UTC; the operator reads Bangladesh time. NOTIF_TZ lets
    // an env override it without a code change.
    timeZone: process.env.NOTIF_TZ ?? "Asia/Dhaka",
  });
}
