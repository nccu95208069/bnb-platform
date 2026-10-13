import test from 'node:test';
import assert from 'node:assert/strict';
import { RedisCustomerStore } from '../src/lib/customer-workspaces/store.ts';
import { beginAcceptanceGmail, finishAcceptanceGmail } from '../src/lib/workspace-auth/acceptance-gmail-oauth.ts';
import { mailStatus } from '../src/lib/workspace-auth/mail.ts';

test('test-account OAuth requires its browser state and verified sender before sending or storing Gmail authorization', async t => {
  const names = ['CUSTOMER_ISOLATED_ACCEPTANCE','CUSTOMER_ACCEPTANCE_GMAIL_OAUTH_ENABLED',
    'CUSTOMER_ACCEPTANCE_GMAIL_OAUTH_CLIENT_ID','CUSTOMER_ACCEPTANCE_GMAIL_OAUTH_CLIENT_SECRET',
    'CUSTOMER_ACCEPTANCE_SENDER_EMAIL','CUSTOMER_ACCEPTANCE_EMAIL_RECIPIENTS',
    'CUSTOMER_DEPLOYMENT_LINKS','CUSTOMER_DEPLOYMENT_ORIGIN','CUSTOMER_WORKSPACE_NAMESPACE',
    'WORKSPACE_AUTH_NAMESPACE','CALENDAR_OWNER_SESSION_SECRET','KV_REST_API_URL','KV_REST_API_TOKEN'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) {
    if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  }});
  Object.assign(process.env, {
    CUSTOMER_ISOLATED_ACCEPTANCE:'true', CUSTOMER_ACCEPTANCE_GMAIL_OAUTH_ENABLED:'true',
    CUSTOMER_ACCEPTANCE_GMAIL_OAUTH_CLIENT_ID:'synthetic-client.apps.googleusercontent.com',
    CUSTOMER_ACCEPTANCE_GMAIL_OAUTH_CLIENT_SECRET:'synthetic-client-secret',
    CUSTOMER_ACCEPTANCE_SENDER_EMAIL:'linlab.ai2024@gmail.com',
    CUSTOMER_ACCEPTANCE_EMAIL_RECIPIENTS:'["linlab.ai2024@gmail.com"]',
    CUSTOMER_DEPLOYMENT_LINKS:'true', CUSTOMER_DEPLOYMENT_ORIGIN:'https://synthetic-pilot.vercel.app',
    CUSTOMER_WORKSPACE_NAMESPACE:'bnb:acceptance:test-gmail-oauth',
    WORKSPACE_AUTH_NAMESPACE:'sweetfun-os:acceptance:test-gmail-oauth',
    CALENDAR_OWNER_SESSION_SECRET:'b'.repeat(64),
    KV_REST_API_URL:'https://redis.invalid', KV_REST_API_TOKEN:'synthetic',
  });
  const values = new Map(), sent = [];
  let mailbox = 'linlab.ai2024@gmail.com';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://redis.invalid') {
      const [command, ...args] = JSON.parse(options.body);
      if (command === 'GET') return Response.json({ result: values.get(args[0]) ?? null });
      if (command === 'SET') { values.set(args[0], args[1]); return Response.json({ result: 'OK' }); }
      if (command === 'EVAL') {
        const keyCount = args[1];
        if (keyCount === 1 && String(args[0]).includes("redis.call('GET'")) {
          const [key, before, after] = args.slice(2);
          if ((values.get(key) ?? '') !== before) return Response.json({ result: 0 });
          values.set(key, after); return Response.json({ result: 1 });
        }
        return Response.json({ result: 1 });
      }
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = options.body;
      if (body.get('grant_type') === 'authorization_code') {
        assert.equal(body.get('redirect_uri'), 'https://synthetic-pilot.vercel.app/api/acceptance-mail/google/callback');
        assert.ok(body.get('code_verifier'));
        return Response.json({ access_token:'synthetic-code-access', refresh_token:'synthetic-refresh',
          scope:'openid email https://www.googleapis.com/auth/gmail.send' });
      }
      assert.equal(body.get('grant_type'), 'refresh_token');
      return Response.json({ access_token:'synthetic-refresh-access',
        scope:'openid email https://www.googleapis.com/auth/gmail.send' });
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo')
      return Response.json({ email:mailbox, email_verified:true });
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
      sent.push(JSON.parse(options.body)); return Response.json({ id:'synthetic-test-message' });
    }
    throw new Error(`unexpected endpoint ${url}`);
  });
  const store = new RedisCustomerStore();
  const started = await beginAcceptanceGmail(store);
  const authUrl = new URL(started.url);
  assert.equal(authUrl.origin, 'https://accounts.google.com');
  assert.equal(authUrl.searchParams.get('access_type'), 'offline');
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authUrl.searchParams.get('login_hint'), 'linlab.ai2024@gmail.com');
  assert.match(authUrl.searchParams.get('scope'), /gmail\.send/);
  await assert.rejects(finishAcceptanceGmail(store, authUrl.searchParams.get('state'), 'wrong-browser', 'synthetic-code'), /FORBIDDEN/);
  assert.equal(sent.length, 0);
  mailbox = 'wrong@example.test';
  await assert.rejects(finishAcceptanceGmail(store, authUrl.searchParams.get('state'), started.browser, 'synthetic-code'), /MAIL_SENDER_MISMATCH/);
  assert.equal(sent.length, 0);
  assert.equal((await mailStatus()).configured, false);
  await assert.rejects(finishAcceptanceGmail(store, authUrl.searchParams.get('state'), started.browser, 'synthetic-code'), /FORBIDDEN/);
  mailbox = 'linlab.ai2024@gmail.com';
  const retry = await beginAcceptanceGmail(store);
  const receipt = await finishAcceptanceGmail(store, new URL(retry.url).searchParams.get('state'), retry.browser, 'synthetic-code');
  assert.equal(receipt.sender, 'linlab.ai2024@gmail.com');
  assert.equal(receipt.messageId, 'synthetic-test-message');
  assert.equal(sent.length, 1);
  assert.equal((await mailStatus()).configured, true);
  assert.ok(!JSON.stringify([...values.values()]).includes('synthetic-refresh'));
  await assert.rejects(beginAcceptanceGmail(store), /MAIL_ALREADY_CONFIGURED/);
});
