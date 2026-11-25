import { isUuid } from "../../../../../lib/admin-authorization.ts";
import { adminAuthFailureResponse, requireAdmin } from "../../../../../lib/admin-auth.ts";
import { createAdminServiceClient } from "../../../../../lib/admin-data.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if (!auth.allowed) return adminAuthFailureResponse(auth);
  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: "注文が見つかりません。" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const supabase = createAdminServiceClient();
  if (!supabase) return Response.json({ error: "注文管理サービスを利用できません。" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  try {
    const { data, error } = await supabase.rpc("get_amuhon_admin_order_detail", { p_order_id: id });
    if (error) return Response.json({ error: "注文詳細を取得できませんでした。" }, { status: 502, headers: { "Cache-Control": "no-store" } });
    if (!data || typeof data !== "object" || Array.isArray(data) || (data as Record<string, unknown>).id !== id) {
      return Response.json({ error: "注文が見つかりません。" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    let pdfRenderJob: Record<string, unknown> = { state: "unavailable" };
    try {
      const renderStatus = await supabase.rpc("get_amuhon_admin_order_pdf_render_status", { p_order_id: id });
      if (!renderStatus.error && renderStatus.data && typeof renderStatus.data === "object" && !Array.isArray(renderStatus.data)) {
        const candidate = renderStatus.data as Record<string, unknown>;
        const allowedStates = new Set(["not_applicable", "not_queued", "queued", "rendering", "succeeded", "failed"]);
        if (typeof candidate.state === "string" && allowedStates.has(candidate.state)) {
          const attempts = candidate.attemptCount;
          const errorCode = candidate.errorCode;
          pdfRenderJob = {
            state: candidate.state,
            ...(Number.isSafeInteger(attempts) && (attempts as number) >= 0 && (attempts as number) <= 5
              ? { attemptCount: attempts } : {}),
            ...(typeof errorCode === "string" && new Set([
              "resend_retryable_failure", "resend_rejected", "resend_outcome_unknown",
              "notification_job_invalid", "order_not_paid", "retry_window_expired", "retry_limit_reached",
            ]).has(errorCode) ? { errorCode } : {}),
            ...(typeof candidate.updatedAt === "string" && Number.isFinite(Date.parse(candidate.updatedAt))
              ? { updatedAt: candidate.updatedAt } : {}),
            ...(typeof candidate.completedAt === "string" && Number.isFinite(Date.parse(candidate.completedAt))
              ? { completedAt: candidate.completedAt } : {}),
          };
        }
      }
    } catch {
      // The queue migration may not be deployed yet; keep the admin order view available.
    }
    let paidNotification: Record<string, unknown> = { state: "unavailable" };
    try {
      const notificationStatus = await supabase.rpc("get_amuhon_admin_order_paid_notification_status_v1", { p_order_id: id });
      if (!notificationStatus.error && notificationStatus.data && typeof notificationStatus.data === "object" && !Array.isArray(notificationStatus.data)) {
        const candidate = notificationStatus.data as Record<string, unknown>;
        const allowedStates = new Set(["not_created", "queued", "sending", "sent", "needs_review", "suppressed"]);
        const allowedNotificationErrors = new Set([
          "resend_retryable_failure", "resend_rejected", "resend_outcome_unknown",
          "notification_job_invalid", "order_not_paid", "retry_window_expired", "retry_limit_reached",
        ]);
        if (typeof candidate.state === "string" && allowedStates.has(candidate.state)) {
          const attempts = candidate.attemptCount;
          const errorCode = candidate.errorCode;
          paidNotification = {
            state: candidate.state,
            ...(Number.isSafeInteger(attempts) && (attempts as number) >= 0 && (attempts as number) <= 8
              ? { attemptCount: attempts } : {}),
            ...(typeof errorCode === "string" && allowedNotificationErrors.has(errorCode) ? { errorCode } : {}),
            ...(typeof candidate.nextAttemptAt === "string" && Number.isFinite(Date.parse(candidate.nextAttemptAt))
              ? { nextAttemptAt: candidate.nextAttemptAt } : {}),
            ...(typeof candidate.sentAt === "string" && Number.isFinite(Date.parse(candidate.sentAt))
              ? { sentAt: candidate.sentAt } : {}),
          };
        }
      }
    } catch {
      // The notification migration may not be deployed yet; keep admin order data available.
    }
    const customerNotifications: Record<string, Record<string, unknown>> = {
      orderConfirmed: { state: "unavailable" },
      orderShipped: { state: "unavailable" },
    };
    try {
      const customerStatus = await supabase.rpc("get_amuhon_admin_order_customer_notification_status_v1", { p_order_id: id });
      if (!customerStatus.error && customerStatus.data && typeof customerStatus.data === "object" && !Array.isArray(customerStatus.data)) {
        const result = customerStatus.data as Record<string, unknown>;
        const states = new Set(["not_created", "queued", "sending", "sent", "needs_review", "suppressed"]);
        const errors = new Set([
          "resend_retryable_failure", "resend_rejected", "resend_outcome_unknown",
          "customer_recipient_not_allowlisted", "customer_delivery_configuration_invalid",
          "customer_order_invalid", "retry_window_expired", "retry_limit_reached",
        ]);
        for (const key of ["orderConfirmed", "orderShipped"] as const) {
          const candidate = result[key];
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
          const item = candidate as Record<string, unknown>;
          if (typeof item.state !== "string" || !states.has(item.state)) continue;
          customerNotifications[key] = {
            state: item.state,
            ...(Number.isSafeInteger(item.attemptCount) && (item.attemptCount as number) >= 0 && (item.attemptCount as number) <= 8
              ? { attemptCount: item.attemptCount } : {}),
            ...(typeof item.errorCode === "string" && errors.has(item.errorCode) ? { errorCode: item.errorCode } : {}),
            ...(typeof item.nextAttemptAt === "string" && Number.isFinite(Date.parse(item.nextAttemptAt))
              ? { nextAttemptAt: item.nextAttemptAt } : {}),
            ...(typeof item.sentAt === "string" && Number.isFinite(Date.parse(item.sentAt)) ? { sentAt: item.sentAt } : {}),
          };
        }
      }
    } catch {
      // Keep order administration available while the additive customer queue migration is pending.
    }
    let productionReadiness: Record<string, unknown> = { rightsApproved: false, assetsReady: false };
    let fulfillmentAudit: unknown[] = [];
    try {
      const [readinessResult, auditResult] = await Promise.all([
        supabase.rpc("get_amuhon_admin_order_production_readiness_v1", { p_order_id: id }),
        supabase.rpc("get_amuhon_admin_order_fulfillment_audit_v1", { p_order_id: id }),
      ]);
      if (!readinessResult.error && readinessResult.data && typeof readinessResult.data === "object" && !Array.isArray(readinessResult.data)) {
        const candidate = readinessResult.data as Record<string, unknown>;
        productionReadiness = {
          rightsApproved: candidate.rightsApproved === true,
          assetsReady: candidate.assetsReady === true,
          renderState: typeof candidate.renderState === "string" && /^[a-z_]{1,32}$/.test(candidate.renderState) ? candidate.renderState : "unavailable",
          pageCount: Number.isSafeInteger(candidate.pageCount) && (candidate.pageCount as number) > 0 ? candidate.pageCount : null,
          spineWidthMm: typeof candidate.spineWidthMm === "number" && Number.isFinite(candidate.spineWidthMm) ? candidate.spineWidthMm : null,
          fulfillmentStatus: typeof candidate.fulfillmentStatus === "string" ? candidate.fulfillmentStatus : "unavailable",
          printerOrderNumber: typeof candidate.printerOrderNumber === "string" ? candidate.printerOrderNumber : null,
          submittedAt: typeof candidate.submittedAt === "string" && Number.isFinite(Date.parse(candidate.submittedAt)) ? candidate.submittedAt : null,
        };
      }
      if (!auditResult.error && auditResult.data && typeof auditResult.data === "object" && !Array.isArray(auditResult.data)) {
        const events = (auditResult.data as Record<string, unknown>).events;
        if (Array.isArray(events)) {
          fulfillmentAudit = events.slice(-100).filter((event): event is Record<string, unknown> =>
            !!event && typeof event === "object" && !Array.isArray(event) &&
            typeof (event as Record<string, unknown>).from === "string" &&
            typeof (event as Record<string, unknown>).to === "string" &&
            typeof (event as Record<string, unknown>).adminUserId === "string" &&
            typeof (event as Record<string, unknown>).createdAt === "string" && Number.isFinite(Date.parse((event as Record<string, unknown>).createdAt as string))
          ).map((event) => ({
            from: event.from,
            to: event.to,
            printerOrderNumber: typeof event.printerOrderNumber === "string" ? event.printerOrderNumber : null,
            adminUserId: event.adminUserId,
            createdAt: event.createdAt,
          }));
        }
      }
    } catch {
      // Missing additive fulfillment migration is represented as unavailable and fail-closed.
    }
    const canDownloadAssets = (data as Record<string, unknown>).canDownloadAssets === true && productionReadiness.assetsReady === true;
    return Response.json({ order: { ...(data as Record<string, unknown>), canDownloadAssets, pdfRenderJob, paidNotification, customerNotifications, productionReadiness, fulfillmentAudit } }, { headers: { "Cache-Control": "no-store, private" } });
  } catch {
    return Response.json({ error: "注文詳細を取得できませんでした。" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
