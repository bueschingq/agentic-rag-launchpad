// Delivery for alerts and leads: a webhook (Slack- and Teams-compatible JSON) and, when SMTP_URL
// is set, email. Each call reports what went where and what failed; callers decide on retries.

import nodemailer from "nodemailer";

export interface Message {
  subject: string;
  text: string;
  // Shown as "name: value" lines in email and as fields in the webhook body.
  fields?: Record<string, string>;
  link?: string;
}

export interface Destinations {
  webhookUrl?: string | null;
  emails?: readonly string[];
}

export interface Delivery {
  delivered: string[];
  errors: string[];
}

// https, or http to this machine for local testing. Staff enter these; nothing else does.
export function webhookUrlProblem(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return undefined;
    if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return undefined;
    return "Use an https address.";
  } catch {
    return "That isn't a web address.";
  }
}

export const smtpConfigured = (env: NodeJS.ProcessEnv = process.env) => Boolean(env.SMTP_URL?.trim());

const lines = (message: Message) =>
  [message.text, ...Object.entries(message.fields ?? {}).map(([k, v]) => `${k}: ${v}`), ...(message.link ? [message.link] : [])].join("\n");

export async function postWebhook(
  url: string,
  message: Message,
  extra: Record<string, unknown> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const problem = webhookUrlProblem(url);
  if (problem) throw new Error(problem);
  const text = `*${message.subject}*\n${lines(message)}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // "text" is what Slack and Teams render; the rest is for automations (Zapier, Power Automate…).
    body: JSON.stringify({ text, subject: message.subject, fields: message.fields ?? {}, link: message.link, ...extra }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`The webhook answered ${res.status}.`);
  await res.body?.cancel();
}

export async function sendEmail(to: readonly string[], message: Message, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!smtpConfigured(env)) throw new Error("Email isn't set up (SMTP_URL).");
  const transport = nodemailer.createTransport(env.SMTP_URL!.trim());
  await transport.sendMail({
    from: env.SMTP_FROM?.trim() || "Launchpad <no-reply@localhost>",
    to: [...to],
    subject: message.subject,
    text: lines(message),
  });
}

export async function deliver(
  to: Destinations,
  message: Message,
  opts: { extra?: Record<string, unknown>; env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
): Promise<Delivery> {
  const result: Delivery = { delivered: [], errors: [] };
  if (to.webhookUrl) {
    try {
      await postWebhook(to.webhookUrl, message, opts.extra, opts.fetch);
      result.delivered.push("webhook");
    } catch (err) {
      result.errors.push(`webhook: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (to.emails?.length && smtpConfigured(opts.env)) {
    try {
      await sendEmail(to.emails, message, opts.env);
      result.delivered.push("email");
    } catch (err) {
      result.errors.push(`email: ${err instanceof Error ? err.message : err}`);
    }
  }
  return result;
}
