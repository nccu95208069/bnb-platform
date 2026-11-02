import test from "node:test";
import assert from "node:assert/strict";
import {
  sealMailPassword,
  assertAcceptanceRecipient,
  sendOperatorIntakeNotification,
  sendCustomerLifecycleMail,
} from "../src/lib/workspace-auth/mail.ts";
import { assertAcceptanceNamespaces } from "../src/lib/workspace-auth/store.ts";
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
test('isolated acceptance refuses recipients outside an exact configured test list', async t => {
  const priorMode = process.env.CUSTOMER_ISOLATED_ACCEPTANCE;
  const priorRecipients = process.env.CUSTOMER_ACCEPTANCE_EMAIL_RECIPIENTS;
  t.after(() => {
    if (priorMode === undefined) delete process.env.CUSTOMER_ISOLATED_ACCEPTANCE;
    else process.env.CUSTOMER_ISOLATED_ACCEPTANCE = priorMode;
    if (priorRecipients === undefined) delete process.env.CUSTOMER_ACCEPTANCE_EMAIL_RECIPIENTS;
    else process.env.CUSTOMER_ACCEPTANCE_EMAIL_RECIPIENTS = priorRecipients;
  });
  process.env.CUSTOMER_ISOLATED_ACCEPTANCE = 'true';
  process.env.CUSTOMER_ACCEPTANCE_EMAIL_RECIPIENTS = '["owner@example.test","guest@example.test"]';
  assert.doesNotThrow(() => assertAcceptanceRecipient('owner@example.test'));
  assert.doesNotThrow(() => assertAcceptanceRecipient('another-tester@example.test', 'auth'));
  assert.throws(() => assertAcceptanceRecipient('actual-guest@example.test'), /MAIL_RECIPIENT_NOT_ALLOWED/);
  await assert.rejects(sendCustomerLifecycleMail('actual-guest@example.test', 'Synthetic notice', 'Synthetic text'), /MAIL_RECIPIENT_NOT_ALLOWED/);
  process.env.CUSTOMER_ACCEPTANCE_EMAIL_RECIPIENTS = '[]';
  assert.throws(() => assertAcceptanceRecipient('owner@example.test'), /MAIL_RECIPIENT_NOT_ALLOWED/);
  process.env.CUSTOMER_ISOLATED_ACCEPTANCE = 'TRUE';
  assert.throws(() => assertAcceptanceRecipient('owner@example.test'), /MAIL_RECIPIENT_NOT_ALLOWED/);
});
test('isolated acceptance refuses default customer and auth storage namespaces', t => {
  const keys = ['CUSTOMER_ISOLATED_ACCEPTANCE', 'CUSTOMER_WORKSPACE_NAMESPACE', 'WORKSPACE_AUTH_NAMESPACE'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]; });
  process.env.CUSTOMER_ISOLATED_ACCEPTANCE = 'true';
  delete process.env.CUSTOMER_WORKSPACE_NAMESPACE;
  delete process.env.WORKSPACE_AUTH_NAMESPACE;
  assert.throws(assertAcceptanceNamespaces, /ACCEPTANCE_STORE_UNAVAILABLE/);
  process.env.CUSTOMER_WORKSPACE_NAMESPACE = 'bnb:acceptance:pilot-20261013';
  process.env.WORKSPACE_AUTH_NAMESPACE = 'sweetfun-os:acceptance:pilot-20261013';
  assert.doesNotThrow(assertAcceptanceNamespaces);
  process.env.CUSTOMER_ISOLATED_ACCEPTANCE = 'TRUE';
  assert.throws(assertAcceptanceNamespaces, /ACCEPTANCE_STORE_UNAVAILABLE/);
});
