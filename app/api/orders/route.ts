import { createHmac, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { validateOrderCustomer, type OrderBookSnapshot, type OrderDraftRequest } from "@/lib/order";
import type { BookWork } from "@/lib/book";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_WORKS = 100;

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

async function readLimitedJson(request: Request): Promise<unknown | null> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) throw new Error("too_large");
  if (!request.body) throw new Error("invalid_json");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new Error("too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("invalid_json");
  }
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean.length > 0 && clean.length <= maxLength ? clean : null;
}

function safeHttpUrl(value: unknown): string | null {
  const input = boundedString(value, 2048);
  if (!input) return null;
  try {
    const url = new URL(input);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseBookSnapshot(input: unknown): OrderBookSnapshot | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  if (!Array.isArray(raw.works) || raw.works.length < 1 || raw.works.length > MAX_WORKS) return null;
  if (raw.coverStyle !== "classic" && raw.coverStyle !== "free") return null;
  if (raw.coverColor !== "red" && raw.coverColor !== "blue" && raw.coverColor !== "green") return null;

  const title = boundedString(raw.title, 200);
  const editor = boundedString(raw.editor, 100);
  if (!title || !editor) return null;

  const works: BookWork[] = [];
  const seenIds = new Set<string>();
  for (const item of raw.works) {
    if (!item || typeof item !== "object") return null;
    const work = item as Record<string, unknown>;
    const id = boundedString(work.id, 200);
    const workTitle = boundedString(work.title, 500);
    const author = typeof work.author === "string" && work.author.length <= 300 ? work.author.trim() : null;
    const cardUrl = safeHttpUrl(work.cardUrl);
    const textUrl = safeHttpUrl(work.textUrl);
    const xhtmlUrl = safeHttpUrl(work.xhtmlUrl);
    if (!id || !workTitle || author === null || !cardUrl || !textUrl || !xhtmlUrl || seenIds.has(id)) return null;
    seenIds.add(id);
    works.push({ id, title: workTitle, author, cardUrl, textUrl, xhtmlUrl });
  }

  return { title, editor, coverStyle: raw.coverStyle, coverColor: raw.coverColor, works };
}

function safePageCount(value: unknown): number | null | undefined {
  if (value === null) return null;
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= 10000
    ? value as number
    : undefined;
}

function getRateLimitIdentity(request: Request): string | null {
  // The deployment ingress must overwrite these headers; do not expose raw addresses to logs or tables.
  const headers = request.headers;
  const ip = headers.get("x-real-ip")?.trim() || headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return ip && ip.length <= 100 ? ip : null;
}

export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return errorResponse("注文情報の形式が正しくありません。", 415);
  }

  const origin = request.headers.get("origin");
  const expectedOrigin = process.env.ORDER_APP_ORIGIN || new URL(request.url).origin;
  if (!origin || origin !== expectedOrigin) return errorResponse("送信元を確認できませんでした。画面を再読み込みしてください。", 403);

  let body: unknown;
  try {
    body = await readLimitedJson(request);
  } catch (error) {
    return errorResponse(error instanceof Error && error.message === "too_large"
      ? "送信内容が上限を超えています。作品数を確認してください。"
      : "送信内容を読み取れませんでした。", error instanceof Error && error.message === "too_large" ? 413 : 400);
  }
  if (!body || typeof body !== "object") return errorResponse("注文情報が不足しています。", 400);

  const raw = body as Record<string, unknown>;
  const idempotencyKey = typeof raw.idempotencyKey === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw.idempotencyKey)
    ? raw.idempotencyKey
    : null;
  const { customer, errors } = validateOrderCustomer(raw.customer);
  const book = parseBookSnapshot(raw.book);
  const declaredBodyPdfPageCount = safePageCount(raw.declaredBodyPdfPageCount);
  if (!idempotencyKey || !customer || !book || declaredBodyPdfPageCount === undefined) {
    return NextResponse.json({
      error: "入力内容または本の情報を確認してください。",
      fields: errors,
    }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const rateLimitSecret = process.env.ORDER_RATE_LIMIT_SECRET;
  const retentionDays = Number(process.env.ORDER_DRAFT_RETENTION_DAYS ?? "30");
  if (!supabaseUrl || !serviceRoleKey || !rateLimitSecret || rateLimitSecret.length < 32 || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    return errorResponse("注文保存サービスが未設定です。入力内容は保存されていません。", 503);
  }

  const clientIp = getRateLimitIdentity(request);
  if (!clientIp) return errorResponse("注文保存サービスの接続情報が不足しています。入力内容は保存されていません。", 503);

  const rateLimitKeyHash = createHmac("sha256", rateLimitSecret).update(clientIp).digest("hex");
  const requestPayload: OrderDraftRequest = { idempotencyKey, customer, book, declaredBodyPdfPageCount };
  const args = {
    p_order_id: randomUUID(),
    p_idempotency_key: requestPayload.idempotencyKey,
    p_customer: requestPayload.customer,
    p_book_snapshot: requestPayload.book,
    p_declared_body_pdf_page_count: requestPayload.declaredBodyPdfPageCount,
    p_rate_limit_key_hash: rateLimitKeyHash,
    p_draft_retention_days: retentionDays,
  };

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(supabaseUrl);
  } catch {
    return errorResponse("注文保存サービスの設定が正しくありません。入力内容は保存されていません。", 503);
  }
  if (databaseUrl.protocol !== "https:" && databaseUrl.hostname !== "localhost") {
    return errorResponse("注文保存サービスの設定が正しくありません。入力内容は保存されていません。", 503);
  }

  try {
    const response = await fetch(`${databaseUrl.origin}/rest/v1/rpc/create_amuhon_order_draft`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(args),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const detail = result && typeof result.message === "string" ? result.message : "";
      if (detail === "ORDER_RATE_LIMITED") return errorResponse("送信回数が上限に達しました。15分ほど待ってからお試しください。", 429);
      return errorResponse("注文を保存できませんでした。入力内容は保存されていません。時間をおいて再試行してください。", 502);
    }

    if (!result || typeof result.id !== "string" || result.status !== "draft" || typeof result.createdAt !== "string") {
      return errorResponse("注文保存結果を確認できませんでした。時間をおいて同じ画面から再試行してください。", 502);
    }
    return NextResponse.json({
      order: { id: result.id, status: result.status, createdAt: result.createdAt },
      duplicate: result.created === false,
      priceStatus: "pending",
    }, { status: result.created === false ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch {
    return errorResponse("注文保存サービスに接続できませんでした。入力内容は保存されていません。時間をおいて再試行してください。", 502);
  }
}
