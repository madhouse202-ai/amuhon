export type OrderPaidNotificationConfig = {
  apiKey: string;
  appOrigin: string | null;
};

export type OrderPaidNotificationOrder = {
  id: string;
  orderNumber: string;
  title: string;
  pageCount: number;
  amountYen: number;
};

export type OrderPaidEmailPayload = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
};

export type OrderPaidEmailSendResult =
  | { ok: true; emailId: string }
  | { ok: false; errorCode: "resend_retryable_failure" | "resend_rejected" | "resend_outcome_unknown" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORDER_NUMBER_PATTERN = /^AMU-\d{8}-[0-9A-F]{8}$/;
const STAGING_SUPABASE_ORIGIN = "https://ahxnmkuvdpzctcwcyadl.supabase.co";

function isStagingSupabaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.origin === STAGING_SUPABASE_ORIGIN && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}

function parseAppOrigin(value: string | undefined, nodeEnv: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
    if (url.protocol === "https:" && url.hostname === "amuhon.jp") return url.origin;
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
    if (nodeEnv === "development" && url.protocol === "http:" && loopback && url.port) return url.origin;
    return null;
  } catch {
    return null;
  }
}

export function resolveOrderPaidNotificationConfig(
  env: NodeJS.ProcessEnv = process.env,
): OrderPaidNotificationConfig | null {
  const apiKey = env.RESEND_API_KEY?.trim();
  const isStaging = isStagingSupabaseUrl(env.SUPABASE_URL);
  const appOrigin = isStaging ? null : parseAppOrigin(env.AMUHON_PUBLIC_ORIGIN, env.NODE_ENV);
  if (!apiKey || !/^re_[A-Za-z0-9_-]{8,}$/.test(apiKey) || (!isStaging && !appOrigin)) return null;
  return { apiKey, appOrigin };
}

export function isValidOrderPaidNotificationOrder(value: unknown): value is OrderPaidNotificationOrder {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const order = value as Partial<OrderPaidNotificationOrder>;
  return typeof order.id === "string" && UUID_PATTERN.test(order.id) &&
    typeof order.orderNumber === "string" && ORDER_NUMBER_PATTERN.test(order.orderNumber) &&
    typeof order.title === "string" && order.title.trim().length > 0 && order.title.length <= 200 &&
    Number.isSafeInteger(order.pageCount) && Number(order.pageCount) > 0 &&
    Number.isSafeInteger(order.amountYen) && Number(order.amountYen) > 0;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

export function createOrderPaidEmailPayload(
  order: OrderPaidNotificationOrder,
  config: OrderPaidNotificationConfig,
): OrderPaidEmailPayload {
  const amount = new Intl.NumberFormat("ja-JP").format(order.amountYen);
  const managementUrl = config.appOrigin
    ? `${config.appOrigin}/admin/orders/${encodeURIComponent(order.id)}`
    : null;
  const subject = `【編む本】注文 ${order.orderNumber} の決済が確定しました`;
  const text = [
    "Stripeの決済が確定しました。",
    `注文番号：${order.orderNumber}`,
    `書名：${order.title}`,
    `ページ数：${order.pageCount}ページ`,
    `金額：${amount}円`,
    managementUrl
      ? `注文管理画面：${managementUrl}`
      : `注文管理画面で注文番号 ${order.orderNumber} を検索してください。`,
  ].join("\n");
  const html = [
    "<p>Stripeの決済が確定しました。</p>",
    "<dl>",
    `<dt>注文番号</dt><dd>${escapeHtml(order.orderNumber)}</dd>`,
    `<dt>書名</dt><dd>${escapeHtml(order.title)}</dd>`,
    `<dt>ページ数</dt><dd>${order.pageCount}ページ</dd>`,
    `<dt>金額</dt><dd>${amount}円</dd>`,
    "</dl>",
    managementUrl
      ? `<p><a href="${escapeHtml(managementUrl)}">注文管理画面を開く</a></p>`
      : `<p>注文管理画面で注文番号 ${escapeHtml(order.orderNumber)} を検索してください。</p>`,
  ].join("");
  return {
    from: "編む本 <notice@amuhon.jp>",
    to: ["amuhon.jp@gmail.com"],
    subject,
    text,
    html,
    idempotencyKey: `amuhon/order-paid/${order.id}`,
  };
}

export async function sendOrderPaidEmail(
  order: OrderPaidNotificationOrder,
  config: OrderPaidNotificationConfig,
): Promise<OrderPaidEmailSendResult> {
  const payload = createOrderPaidEmailPayload(order, config);
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": payload.idempotencyKey,
      },
      body: JSON.stringify({
        from: payload.from,
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
      }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, errorCode: "resend_outcome_unknown" };
  }

  if (!response.ok) {
    return {
      ok: false,
      errorCode: response.status === 409 || response.status === 429 || response.status >= 500
        ? "resend_retryable_failure"
        : "resend_rejected",
    };
  }
  const body = await response.json().catch(() => null) as { id?: unknown } | null;
  if (!body || typeof body.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.id)) {
    return { ok: false, errorCode: "resend_outcome_unknown" };
  }
  return { ok: true, emailId: body.id };
}
