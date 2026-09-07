const { test, expect } = require('@playwright/test');
const {
  invoiceFixture,
  invoiceFormatFixtures,
  invalidParserFixtures,
  uniqueUpload,
} = require('../fixtures/invoice-test-assets');
const { getSessionPage } = require('../fixtures/session-auth');

test.setTimeout(420_000);
test.describe.configure({ mode: 'serial' });

function parseWaitTimeoutMs(text) {
  const match = text.match(/Wait time\s*(?:(\d+)m)?(?:(\d+)s)?/i);
  return match ? (Number(match[1] || 0) * 60 + Number(match[2] || 0) + 5) * 1000 : 0;
}

async function requestOtpToken(api) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await api.post(`${process.env.PLATFORM_API_BASE_URL}/v1/payout-platform/auth/request-otp-email`, {
      data: { email: process.env.PLATFORM_USER_EMAIL, password: process.env.PLATFORM_USER_PASSWORD },
      timeout: 30_000,
    });
    const text = await response.text();
    if (response.ok()) return JSON.parse(text).result.temp_token;
    const waitMs = parseWaitTimeoutMs(text);
    if (waitMs && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    throw new Error(`request OTP email failed: ${response.status()} ${text}`);
  }
}

async function login(page, api) {
  await page.goto('/dashboard');
  if (!page.url().includes('/login')) return;

  let accessToken;
  page.on('response', async (response) => {
    if (response.url().endsWith('/v1/payout-platform/auth/login') && response.ok()) {
      accessToken = (await response.json()).result.access_token;
    }
  });

  await page.goto('/login');
  await page.getByRole('textbox', { name: /Email/i }).fill(process.env.PLATFORM_USER_EMAIL);
  await page.getByRole('textbox', { name: /Password/i }).fill(process.env.PLATFORM_USER_PASSWORD);
  await page.getByRole('button', { name: 'Send OTP' }).click();
  try {
    await page.waitForURL(/\/otp/, { timeout: 35_000 });
  } catch {
    await page.getByRole('button', { name: 'Enter existing OTP code' }).click();
    try {
      await page.waitForURL(/\/otp/, { timeout: 30_000 });
    } catch {
      const tempToken = await requestOtpToken(api);
      await page.evaluate(
        ({ email, tempToken: token }) => localStorage.setItem('pp.temp_auth', JSON.stringify({ email, temp_token: token })),
        { email: process.env.PLATFORM_USER_EMAIL, tempToken },
      );
      await page.goto('/otp');
    }
  }
  await page.getByText('OTP verification').waitFor({ timeout: 15_000 });
  const otpInput = page.locator('input').first();
  await otpInput.click();
  await otpInput.pressSequentially(process.env.PLATFORM_EMAIL_OTP, { delay: 25 });
  try {
    await page.waitForURL((url) => !url.pathname.includes('/login') && !url.pathname.includes('/otp'), { timeout: 12_000 });
  } catch {
    const verify = page.getByRole('button', { name: /Verify/i });
    if (await verify.isEnabled().catch(() => false)) await verify.click();
    await page.waitForURL((url) => !url.pathname.includes('/login') && !url.pathname.includes('/otp'), { timeout: 45_000 });
  }
  await expect.poll(() => accessToken).toBeTruthy();
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function uploadAndFind(page, upload) {
  const fileName = upload.name;
  await page.getByRole('button', { name: 'Upload invoice' }).click();
  await page.locator('input[type="file"]').setInputFiles(upload);
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  const row = page.getByRole('row', { name: new RegExp(escaped(fileName)) });
  await expect(row).toBeVisible({ timeout: 45_000 });
  await expect(row.getByText(/parsing…|Processing|Pending/i)).toHaveCount(0, { timeout: 90_000 });
  return row;
}

test.describe('Invoice parser format contracts', () => {
  test.beforeEach(() => {
    if (process.env.PLATFORM_ENV !== 'stage') {
      throw new Error('INV-PARSER scenarios require PLATFORM_ENV=stage because they upload real invoices.');
    }
    if (process.env.ALLOW_MUTATING_INVOICE_PARSER_TESTS !== 'true') {
      throw new Error('Set ALLOW_MUTATING_INVOICE_PARSER_TESTS=true to run INV-PARSER scenarios.');
    }
  });

  test('INV-PARSER-001: valid ZAR documents retain a non-zero amount for every supported format', async ({ browser, request }, testInfo) => {
    const page = await getSessionPage(browser);
    await login(page, request);
    await page.goto('/invoice-inbox?page=1&limit=25');
    for (const fixturePath of invoiceFormatFixtures()) {
      const row = await uploadAndFind(page, uniqueUpload(fixturePath, 'INV-PARSER-VALID', testInfo));
      await expect(row.getByText('new', { exact: true })).toBeVisible();
      await expect(row).toContainText(/R\s*[1-9]/);
      await expect(row.getByRole('button', { name: /parse failed/i })).toHaveCount(0);
    }
  });

  test('INV-PARSER-002: corrupted documents expose a terminal INVALID_DOCUMENT reason', async ({ browser, request }, testInfo) => {
    const page = await getSessionPage(browser);
    await login(page, request);
    await page.goto('/invoice-inbox?page=1&limit=25');
    for (const fixturePath of invalidParserFixtures()) {
      const row = await uploadAndFind(page, uniqueUpload(fixturePath, 'INV-PARSER-INVALID', testInfo));
      await expect(row).toContainText('parse failed');
      await expect(row).toContainText(/INVALID_DOCUMENT/i);
      await expect(row.getByRole('checkbox')).toHaveCount(0);
    }
  });

  test('INV-PARSER-003: a file whose bytes do not match its extension is rejected and cannot enter a batch', async ({ browser, request }, testInfo) => {
    const page = await getSessionPage(browser);
    await login(page, request);
    await page.goto('/invoice-inbox?page=1&limit=25');
    const row = await uploadAndFind(
      page,
      uniqueUpload(invoiceFixture('extensionMismatch'), 'INV-PARSER-MISMATCH', testInfo),
    );
    await expect(row).toContainText('parse failed');
    await expect(row.getByRole('checkbox')).toHaveCount(0);
  });
});
