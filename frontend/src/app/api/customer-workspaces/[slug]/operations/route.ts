import { orderMutation } from "@/lib/customer-workspaces/order-mutations";
import { amendWebsiteBooking } from "@/lib/customer-workspaces/website-amendment";
import { holdOperation } from "@/lib/customer-workspaces/holds";
import { createHold } from "@/lib/customer-workspaces/service";
import {
  calendarWindow,
  queryOrders,
} from "@/lib/customer-workspaces/order-query";
import { loadWorkspace, view } from "@/lib/customer-workspaces/service";
import { NextRequest, NextResponse } from "next/server";
import { scheduleStandardSheetForSlug } from "@/lib/customer-workspaces/standard-sheet-jobs";
import {
  body,
  failure,
  headers,
  principal,
  store,
} from "@/lib/customer-workspaces/http";
import {
  addProperty,
  availability,
  bookingOperation,
  saveAvailabilityList,
  setPricing,
} from "@/lib/customer-workspaces/operations";
import {
  createInvitation,
  invitationUrl,
  manageMember,
  memberSettings,
  roleLabels,
} from "@/lib/customer-workspaces/invitations";
import { deliverOnce } from "@/lib/customer-intake/delivery";
import { intakePreview } from "@/lib/customer-intake/config";
import { sendCustomerLifecycleMail } from "@/lib/workspace-auth/mail";
export const runtime = "nodejs";
export const maxDuration = 60;
type Context = { params: Promise<{ slug: string }> };
export async function GET(request: NextRequest, context: Context) {
  try {
    const account = await principal(request),
      { slug } = await context.params;
    const query = Object.fromEntries(request.nextUrl.searchParams);
    if (query.view === "calendar") {
      const loaded = await loadWorkspace(store, account.id, slug);
      return NextResponse.json(
        calendarWindow(view(loaded.workspace, loaded.member), query),
        { headers },
      );
    }
    if (query.view === "orders") {
      const loaded = await loadWorkspace(store, account.id, slug);
      return NextResponse.json(
        queryOrders(view(loaded.workspace, loaded.member), query),
        { headers },
      );
    }
    if (query.view === "members")
      return NextResponse.json(await memberSettings(store, account.id, slug), {
        headers,
      });
    if (query.view !== "availability") throw new Error("INVALID_INPUT");
    return NextResponse.json(
      await availability(store, account.id, slug, {
        ...query,
        showPrices: query.showPrices === "true",
      }),
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: NextRequest, context: Context) {
  try {
    const input = await body(request),
      account = await principal(request),
      { slug } = await context.params;
    await store.limit(`operations:${account.id}`, 300);
    const args = [store, account.id, slug, input] as const;
    let result: unknown;
    switch (input.action) {
      case "website-amend":
        result = await amendWebsiteBooking(...args);
        break;
      case "hold-create": {
        const created = await createHold(...args);
        result = { bookingId: created.booking.id, workspace: created.workspace };
        break;
      }
      case "hold-extend":
      case "hold-convert":
      case "hold-release":
      case "hold-late-payment":
      case "hold-refund":
        result = await holdOperation(...args);
        break;
      case "order-details":
      case "order-tags":
      case "tag":
      case "receipt-account":
        result = await orderMutation(...args);
        break;
      case "property":
        result = await addProperty(...args);
        break;
      case "pricing":
        result = await setPricing(...args);
        break;
      case "availability-list":
        result = await saveAvailabilityList(...args);
        break;
      case "payment":
      case "opening":
      case "terms":
      case "cancel":
        result = await bookingOperation(...args);
        break;
      case "member":
      case "revoke":
        result = await manageMember(...args);
        break;
      case "invite": {
        await store.limit(`invitations:${account.id}`, 20);
        const { workspace, invitation } = await createInvitation(
          store,
          account,
          slug,
          input,
        );
        const delivery = await deliverOnce(
          store,
          `invitation-mail:${invitation.id}`,
          invitation.email,
          "旅宿工作區｜協作邀請",
          `你受邀加入「${workspace.name}」。\n角色：${roleLabels[invitation.role]}\n可使用旅宿：${
            invitation.allProperties
              ? "全部旅宿（含日後新增）"
              : workspace.properties
                  .filter((p) => invitation.propertyIds.includes(p.id))
                  .map((p) => p.name)
                  .join("、")
          }\n\n請於七天內開啟以下連結：\n${invitationUrl(workspace.id, invitation)}\n\n已有帳號請使用原密碼確認加入；新帳號可自行設定密碼。管理者不會知道你的密碼。若未預期收到邀請，可忽略此信。`,
          sendCustomerLifecycleMail,
          intakePreview(),
        );
        result = {
          ...(await memberSettings(store, account.id, slug)),
          delivery: delivery.status,
          invitationId: invitation.id,
        };
        break;
      }
      default:
        throw new Error("INVALID_INPUT");
    }
    await scheduleStandardSheetForSlug(store, account.id, slug);
    return NextResponse.json(result, { headers });
  } catch (error) {
    return failure(error);
  }
}
