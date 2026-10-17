import type { BookData, BookWork } from "./book";

export const JAPANESE_PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
  "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
  "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
  "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
] as const;

export type OrderCustomer = {
  name: string;
  postalCode: string;
  prefecture: string;
  city: string;
  address: string;
  phone: string;
  email: string;
};

export type OrderBookSnapshot = {
  title: string;
  editor: string;
  coverStyle: BookData["coverStyle"];
  coverColor: BookData["coverColor"];
  works: BookWork[];
};

export type OrderDraftRequest = {
  idempotencyKey: string;
  customer: OrderCustomer;
  book: OrderBookSnapshot;
  declaredBodyPdfPageCount: number | null;
};

export type OrderFieldErrors = Partial<Record<keyof OrderCustomer, string>>;

export function validateOrderCustomer(input: unknown): {
  customer: OrderCustomer | null;
  errors: OrderFieldErrors;
} {
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const value = (field: keyof OrderCustomer) => typeof raw[field] === "string" ? raw[field].trim() : "";
  const customer: OrderCustomer = {
    name: value("name"),
    postalCode: value("postalCode").replace(/[‐‑‒–—−ー]/g, "-"),
    prefecture: value("prefecture"),
    city: value("city"),
    address: value("address"),
    phone: value("phone"),
    email: value("email"),
  };
  const errors: OrderFieldErrors = {};

  if (!customer.name || customer.name.length > 100) errors.name = "氏名を1〜100文字で入力してください。";
  if (!/^\d{3}-?\d{4}$/.test(customer.postalCode)) errors.postalCode = "郵便番号を7桁で入力してください。";
  else customer.postalCode = customer.postalCode.replace(/-/g, "").replace(/^(\d{3})(\d{4})$/, "$1-$2");
  if (!(JAPANESE_PREFECTURES as readonly string[]).includes(customer.prefecture)) errors.prefecture = "都道府県を選択してください。";
  if (!customer.city || customer.city.length > 100) errors.city = "市区町村を1〜100文字で入力してください。";
  if (!customer.address || customer.address.length > 200) errors.address = "番地・建物名を1〜200文字で入力してください。";
  const normalizedPhone = customer.phone.replace(/[()\s-]/g, "");
  if (!/^0\d{9,10}$/.test(normalizedPhone)) errors.phone = "電話番号を国内形式の10〜11桁で入力してください。";
  else customer.phone = normalizedPhone;
  if (customer.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) errors.email = "有効なメールアドレスを入力してください。";

  return { customer: Object.keys(errors).length ? null : customer, errors };
}

export function isReadyForPayment(order: {
  status: string;
  bodyPdfPageCount: number | null;
  bodyPdfStoragePath: string | null;
  coverPngStoragePath: string | null;
  amountMinor: number | null;
  currency: string | null;
  filesValidatedAt: string | null;
}): boolean {
  return order.status === "ready_for_payment" &&
    Number.isInteger(order.bodyPdfPageCount) &&
    Boolean(order.bodyPdfStoragePath && order.coverPngStoragePath && order.filesValidatedAt) &&
    Number.isInteger(order.amountMinor) &&
    Boolean(order.currency);
}

export function canTransitionOrderStatus(from: string, to: string): boolean {
  const transitions: Record<string, readonly string[]> = {
    draft: ["preparing", "cancelled", "failed"],
    preparing: ["ready_for_payment", "cancelled", "failed"],
    ready_for_payment: ["paid", "cancelled"],
    failed: ["preparing", "cancelled"],
    paid: [],
    cancelled: [],
  };
  return transitions[from]?.includes(to) ?? false;
}
