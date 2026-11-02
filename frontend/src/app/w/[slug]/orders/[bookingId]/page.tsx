import { notFound } from "next/navigation";
import { customerPage } from "@/lib/customer-workspaces/page-context";
import { OrderDetail } from "@/components/customer-workspaces/order-detail";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "旅宿工作區｜訂單明細",
  robots: { index: false, follow: false },
};
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; bookingId: string }>;
  searchParams: Promise<{ back?: string; date?: string; room?: string }>;
}) {
  const { slug, bookingId } = await params,
    raw = await searchParams;
  const query = Object.fromEntries(
    Object.entries(raw).filter(
      (pair): pair is [string, string] => typeof pair[1] === "string",
    ),
  );
  const queryString = new URLSearchParams(
    Object.entries(query).filter(
      (pair): pair is [string, string] => typeof pair[1] === "string",
    ),
  ).toString();
  const data = await customerPage(
    slug,
    `orders/${encodeURIComponent(bookingId)}${queryString ? `?${queryString}` : ""}`,
  );
  if (!data || !data.bookings.some((b) => b.id === bookingId)) notFound();
  const back =
    query.back &&
    [`/w/${slug}/orders`, `/w/${slug}/calendar`, `/w/${slug}/finance`].some(
      (path) =>
        query.back === path ||
        query.back?.startsWith(`${path}?`) ||
        query.back?.startsWith(`${path}#`),
    )
      ? query.back
      : `/w/${slug}/orders`;
  return (
    <OrderDetail
      initial={{
        ...data,
        bookings: data.bookings.filter((b) => b.id === bookingId),
      }}
      bookingId={bookingId}
      backHref={back}
      selectedDate={
        /^\d{4}-\d{2}-\d{2}$/.test(query.date || "") ? query.date : undefined
      }
      selectedRoom={query.room}
    />
  );
}
