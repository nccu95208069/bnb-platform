import { NextRequest, NextResponse } from "next/server";
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
    return NextResponse.json(result, { headers });
  } catch (error) {
    return failure(error);
  }
}
