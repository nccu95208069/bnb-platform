import test from "node:test";
import assert from "node:assert/strict";
import {
  sealMailPassword,
  sendOperatorIntakeNotification,
  sendCustomerLifecycleMail,
} from "../src/lib/workspace-auth/mail.ts";
test("operator intake mail uses configured Gmail, validates sender and always addresses fixed recipient", async (t) => {
  process.env.CALENDAR_OWNER_SESSION_SECRET = "a".repeat(64);
  process.env.KV_REST_API_URL = "https://redis.invalid";
  process.env.KV_REST_API_TOKEN = "synthetic";
  const secret = sealMailPassword(
    JSON.stringify({
      clientId: "synthetic",
      clientSecret: "synthetic",
      refreshToken: "synthetic",
    }),
  );
  let sent;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "https://redis.invalid")
      return Response.json({
        result: JSON.stringify({ method: "gmail_oauth", secret }),
      });
    if (String(url).includes("oauth2.googleapis.com"))
      return Response.json({
        access_token: "synthetic-token",
        scope: "https://www.googleapis.com/auth/gmail.send",
      });
    if (String(url).endsWith("/profile"))
      return Response.json({ emailAddress: "sweetfuntw@gmail.com" });
    if (String(url).endsWith("/messages/send")) {
      sent = Buffer.from(JSON.parse(options.body).raw, "base64url").toString();
      return Response.json({ id: "synthetic-message-id" });
    }
    throw Error("unexpected request");
  });
  const id = await sendOperatorIntakeNotification(
    "民宿 OS｜新的專人諮詢需求",
    "Synthetic inquiry content",
  );
  assert.equal(id, "synthetic-message-id");
  assert.match(sent, /To: linlab.ai2024@gmail.com\r\n/);
  assert.match(sent, /From: Sweetfun OS <sweetfuntw@gmail.com>/);
  assert.equal(sent.includes("Bcc:"), false);
  await sendCustomerLifecycleMail(
    "applicant@example.test",
    "旅宿服務｜確認信",
    "Synthetic account link",
  );
  assert.match(sent, /To: applicant@example.test\r\n/);
  assert.equal(sent.includes("To: linlab.ai2024@gmail.com"), false);
  await assert.rejects(
    sendOperatorIntakeNotification("subject\r\nBcc: someone", "text"),
    /INVALID_INPUT/,
  );
});
