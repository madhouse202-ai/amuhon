import PaymentResult from "../payment-result";

export default async function OrderPaymentCancelPage({
  searchParams,
}: {
  searchParams: Promise<{ order_id?: string | string[] }>;
}) {
  const value = (await searchParams).order_id;
  return <PaymentResult mode="cancel" orderId={typeof value === "string" ? value : undefined} />;
}
