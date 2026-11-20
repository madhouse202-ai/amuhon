import { createHmac, randomBytes, randomUUID } from "node:crypto";

import { validateOrderCustomer, type OrderBookSnapshot, type OrderDraftRequest } from "../../../lib/order.ts";
import { hashOrderUploadToken } from "../../../lib/order-upload-token.ts";
import { serializeOrderUploadCookie } from "../../../lib/order-upload-cookie.ts";
import { createSupabaseServiceHeaders, getSupabaseServiceCredential } from "../../../lib/supabase-service-credential.ts";
import { callOrderRpc, getSupabaseServerConfig } from "../../../lib/order-checkout-server.ts";
import { parseCommercialRightsApproval } from "../../../lib/commercial-rights.ts";
import { resolveAozoraWorkEditions } from "../../../lib/aozora-edition.ts";
import { isLegacyBuyerAssetFlowEnabled } from "../../../lib/order-production-gate.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_WORKS = 100;

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
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

type ParsedBookSelection = Omit<OrderBookSnapshot, "works"> & { workIds: string[] };

function parseBookSelection(input: unknown): ParsedBookSelection | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  if (!Array.isArray(raw.works) || raw.works.length < 1 || raw.works.length > MAX_WORKS) return null;
  if (raw.coverStyle !== "classic" && raw.coverStyle !== "free") return null;
  if (raw.coverColor !== "red" && raw.coverColor !== "blue" && raw.coverColor !== "green") return null;

  const title = boundedString(raw.title, 200);
  const editor = boundedString(raw.editor, 100);
  if (!title || !editor) return null;

  const workIds: string[] = [];
  const seenIds = new Set<string>();
  for (const item of raw.works) {
    if (!item || typeof item !== "object") return null;
    const work = item as Record<string, unknown>;
    const id = boundedString(work.id, 200);
    // The browser cannot claim the catalog metadata, edition URL, digest, or
    // permission conditions used by the commercial-rights ledger.
    if (!id || !/^\d{1,12}$/.test(id) || seenIds.has(id) || work.sourceSha256 !== undefined || work.rightsNotice !== undefined) return null;
    seenIds.add(id);
    workIds.push(id);
  }

  return { title, editor, coverStyle: raw.coverStyle, coverColor: raw.coverColor, workIds };
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
  if (!isLegacyBuyerAssetFlowEnabled()) {
    return errorResponse("印刷データをサーバーで安全に準備する注文機能を整備中です。入力内容は保存されていません。", 503);
  }
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
  const bookSelection = parseBookSelection(raw.book);
  const declaredBodyPdfPageCount = safePageCount(raw.declaredBodyPdfPageCount);
  if (!idempotencyKey || !customer || !bookSelection || declaredBodyPdfPageCount === undefined) {
    return Response.json({
      error: "入力内容または本の情報を確認してください。",
      fields: errors,
    }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceCredential = getSupabaseServiceCredential();
  const rateLimitSecret = process.env.ORDER_RATE_LIMIT_SECRET;
  const retentionDays = Number(process.env.ORDER_DRAFT_RETENTION_DAYS ?? "30");
  if (!supabaseUrl || !serviceCredential || !rateLimitSecret || rateLimitSecret.length < 32 || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    return errorResponse("注文保存サービスが未設定です。入力内容は保存されていません。", 503);
  }

  const clientIp = getRateLimitIdentity(request);
  if (!clientIp) return errorResponse("注文保存サービスの接続情報が不足しています。入力内容は保存されていません。", 503);

  const rateLimitKeyHash = createHmac("sha256", rateLimitSecret).update(clientIp).digest("hex");

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(supabaseUrl);
  } catch {
    return errorResponse("注文保存サービスの設定が正しくありません。入力内容は保存されていません。", 503);
  }
  if (databaseUrl.protocol !== "https:" && databaseUrl.hostname !== "localhost") {
    return errorResponse("注文保存サービスの設定が正しくありません。入力内容は保存されていません。", 503);
  }

  const rightsConfig = getSupabaseServerConfig();
  if (!rightsConfig || rightsConfig.url.origin !== databaseUrl.origin) {
    return errorResponse("作品の利用条件を確認できません。入力内容は保存されていません。", 503);
  }
  let requestPayload: OrderDraftRequest;
  try {
    const catalogWorks = await resolveAozoraWorkEditions(bookSelection.workIds);
    const rightsWorks: OrderBookSnapshot["works"] = catalogWorks.map(({ id, title, author, cardUrl, textUrl, xhtmlUrl, contributors, sourceMetadata, sourceSha256 }) => ({
      id,
      title,
      author,
      cardUrl,
      textUrl,
      xhtmlUrl,
      contributors: contributors.map(({ name, role }) => ({ name, role })),
      sourceMetadata,
      sourceSha256,
    }));
    const rights = await callOrderRpc(rightsConfig, "check_amuhon_works_commercial_rights_v1", {
      p_works: rightsWorks,
    });
    const approval = parseCommercialRightsApproval(rights.data);
    if (!rights.ok || approval === null) return errorResponse("作品の利用条件を確認できません。入力内容は保存されていません。", 503);
    if (!approval.approved) return errorResponse("選択した作品は販売用の利用確認が完了していません。注文内容は保存されていません。", 409);
    if (approval.notices.length !== rightsWorks.length) return errorResponse("作品の利用条件を確認できません。入力内容は保存されていません。", 503);
    const approvedWorks = rightsWorks.map((work) => {
      const notice = approval.notices.find((item) => item.workId === work.id);
      if (!notice || notice.sourceSha256 !== work.sourceSha256) throw new Error("commercial_rights_notice_mismatch");
      return { ...work, sourceSha256: notice.sourceSha256, rightsNotice: notice.conditions };
    });
    requestPayload = {
      idempotencyKey,
      customer,
      book: {
        title: bookSelection.title,
        editor: bookSelection.editor,
        coverStyle: bookSelection.coverStyle,
        coverColor: bookSelection.coverColor,
        works: approvedWorks,
      },
      declaredBodyPdfPageCount,
    };
  } catch {
    return errorResponse("作品の利用条件を確認できません。入力内容は保存されていません。", 503);
  }

  const uploadToken = randomBytes(32).toString("base64url");
  const args = {
    p_order_id: randomUUID(),
    p_idempotency_key: requestPayload.idempotencyKey,
    p_customer: requestPayload.customer,
    p_book_snapshot: requestPayload.book,
    p_declared_body_pdf_page_count: requestPayload.declaredBodyPdfPageCount,
    p_rate_limit_key_hash: rateLimitKeyHash,
    p_upload_token_hash: hashOrderUploadToken(uploadToken),
    p_draft_retention_days: retentionDays,
  };

  try {
    const rpcResponse = await fetch(`${databaseUrl.origin}/rest/v1/rpc/create_amuhon_order_draft_with_upload_token`, {
      method: "POST",
      headers: createSupabaseServiceHeaders(serviceCredential, {
        "Content-Type": "application/json",
        Accept: "application/json",
      }),
      body: JSON.stringify(args),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const result = await rpcResponse.json().catch(() => null) as Record<string, unknown> | null;
    if (!rpcResponse.ok) {
      const detail = result && typeof result.message === "string" ? result.message : "";
      if (detail === "ORDER_RATE_LIMITED") return errorResponse("送信回数が上限に達しました。15分ほど待ってからお試しください。", 429);
      if (detail === "ORDER_FILE_UPLOAD_IN_PROGRESS") return errorResponse("この注文のファイル処理が進行中です。完了後に画面を確認してください。", 409);
      if (detail === "IDEMPOTENCY_KEY_REUSE_MISMATCH") return errorResponse("同じ送信キーで異なる注文情報が送信されました。画面を再読み込みしてやり直してください。", 409);
      return errorResponse("注文を保存できませんでした。入力内容は保存されていません。時間をおいて再試行してください。", 502);
    }

    if (!result || typeof result.id !== "string" || !["draft", "preparing"].includes(String(result.status)) || typeof result.createdAt !== "string") {
      return errorResponse("注文保存結果を確認できませんでした。時間をおいて同じ画面から再試行してください。", 502);
    }
    if (result.uploadTokenAccepted !== true) {
      return errorResponse("この注文はすでにファイル処理済みです。注文状況を確認してください。", 409);
    }
    const response = Response.json({
      order: { id: result.id, status: result.status, createdAt: result.createdAt },
      duplicate: result.created === false,
      priceStatus: "pending",
    }, { status: result.created === false ? 200 : 201, headers: { "Cache-Control": "no-store" } });
    response.headers.append("Set-Cookie", serializeOrderUploadCookie(result.id, uploadToken, retentionDays * 24 * 60 * 60));
    return response;
  } catch {
    return errorResponse("注文保存サービスに接続できませんでした。入力内容は保存されていません。時間をおいて再試行してください。", 502);
  }
}
