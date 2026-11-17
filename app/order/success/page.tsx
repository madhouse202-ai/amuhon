import PaymentResult from "../payment-result";

export default async function OrderPaymentSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ order_id?: string | string[]; session_id?: string | string[] }>;
}) {
  const params = await searchParams;
  return <PaymentResult
    mode="success"
    orderId={typeof params.order_id === "string" ? params.order_id : undefined}
    sessionId={typeof params.session_id === "string" ? params.session_id : undefined}
  />;
}
