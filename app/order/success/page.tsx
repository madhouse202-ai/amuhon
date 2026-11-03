import PaymentResult from "../payment-result";

export default async function OrderPaymentSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ order_id?: string | string[] }>;
}) {
  const value = (await searchParams).order_id;
  return <PaymentResult mode="success" orderId={typeof value === "string" ? value : undefined} />;
}
