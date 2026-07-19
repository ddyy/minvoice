import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { sendTestEmail } from '../src/services/email';

const DB = env.DB;

beforeEach(async () => {
  await DB.prepare(
    `UPDATE settings SET business_email = 'owner@example.test', business_name = 'Test Biz',
     email_provider = 'cloudflare', email_from = 'billing@example.test', setup_complete = 1 WHERE id = 1`
  ).run();
});

describe('sendTestEmail', () => {
  it('sends a sample invoice email with PDF to the business email', async () => {
    const sent: {
      to?: string;
      subject?: string;
      from?: { email: string; name: string };
      attachments?: { filename: string; content: Uint8Array }[];
    }[] = [];
    const EMAIL = {
      async send(msg: (typeof sent)[number]) {
        sent.push(msg);
      },
    } as unknown as SendEmail;

    const to = await sendTestEmail({ ...env, EMAIL }, DB);
    expect(to).toBe('owner@example.test');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('owner@example.test');
    expect(sent[0].subject).toContain('SAMPLE'); // real invoice-email subject, fake number
    expect(sent[0].from?.email).toBe('billing@example.test');
    // The real PDF rides along (ASCII sample -> fast WinAnsi path -> compact file)
    expect(sent[0].attachments).toHaveLength(1);
    expect(sent[0].attachments![0].filename).toMatch(/SAMPLE\.pdf$/);
    expect(sent[0].attachments![0].content.length).toBeGreaterThan(1000);
  });

  it('no database rows are created by the sample invoice', async () => {
    const EMAIL = { async send() {} } as unknown as SendEmail;
    const before = await DB.prepare('SELECT COUNT(*) AS n FROM invoices').first<{ n: number }>();
    await sendTestEmail({ ...env, EMAIL }, DB);
    const after = await DB.prepare('SELECT COUNT(*) AS n FROM invoices').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it('throws a descriptive error when no from-address is configured', async () => {
    await DB.prepare(`UPDATE settings SET email_from = '' WHERE id = 1`).run();
    await expect(sendTestEmail(env, DB)).rejects.toThrow(/sending address/i);
  });

  it('throws when no business email is set to receive the test', async () => {
    await DB.prepare(`UPDATE settings SET business_email = NULL WHERE id = 1`).run();
    await expect(sendTestEmail(env, DB)).rejects.toThrow(/business email/i);
  });
});

describe('email settings guard', () => {
  async function loginCookie(): Promise<string> {
    const r = await exports.default.fetch(
      new Request('https://invoice.test/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
        body: 'password=integration-test-password',
        redirect: 'manual',
      })
    );
    return r.headers.get('set-cookie')?.split(';')[0] ?? '';
  }

  it('refuses to switch to Resend when no key exists anywhere', async () => {
    await DB.prepare(`UPDATE settings SET email_provider = 'cloudflare', resend_api_key = '' WHERE id = 1`).run();
    const cookie = await loginCookie();
    const r = await exports.default.fetch(
      new Request('https://invoice.test/admin/settings/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
          cookie,
        },
        body: 'email_provider=resend&email_from=b%40x.test&reminder_schedule=1',
        redirect: 'manual',
      })
    );
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toContain('resend_kept=1');
    const row = await DB.prepare('SELECT email_provider FROM settings').first<{ email_provider: string }>();
    expect(row?.email_provider).toBe('cloudflare'); // previous provider kept
  });

  it('allows Resend when a key is submitted in the same save', async () => {
    await DB.prepare(`UPDATE settings SET email_provider = 'cloudflare', resend_api_key = '' WHERE id = 1`).run();
    const cookie = await loginCookie();
    const r = await exports.default.fetch(
      new Request('https://invoice.test/admin/settings/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
          cookie,
        },
        body: 'email_provider=resend&email_from=b%40x.test&reminder_schedule=1&resend_api_key=re_live_abc123',
        redirect: 'manual',
      })
    );
    expect(r.headers.get('location')).not.toContain('resend_kept');
    const row = await DB.prepare('SELECT email_provider, resend_api_key FROM settings').first<{
      email_provider: string;
      resend_api_key: string;
    }>();
    expect(row?.email_provider).toBe('resend');
    expect(row?.resend_api_key).toBe('re_live_abc123');
  });
});
