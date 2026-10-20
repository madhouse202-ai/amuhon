import { isValidOrderUploadToken } from "./order-upload-token.ts";

const ORDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function orderUploadCookieName(orderId: string): string {
  if (!ORDER_ID_PATTERN.test(orderId)) throw new Error("invalid_order_id");
  return `amuhon_order_upload_${orderId.toLowerCase()}`;
}

export function serializeOrderUploadCookie(orderId: string, token: string, maxAgeSeconds: number): string {
  if (!isValidOrderUploadToken(token) || !Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1) {
    throw new Error("invalid_order_upload_cookie");
  }
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${orderUploadCookieName(orderId)}=${token}; Path=/api/orders/${orderId}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

export function readOrderUploadCookie(request: Request, orderId: string): string | null {
  const cookieName = orderUploadCookieName(orderId);
  const cookieHeader = request.headers.get("cookie") ?? "";
  for (const item of cookieHeader.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== cookieName) continue;
    const token = item.slice(separator + 1).trim();
    return isValidOrderUploadToken(token) ? token : null;
  }
  return null;
}
