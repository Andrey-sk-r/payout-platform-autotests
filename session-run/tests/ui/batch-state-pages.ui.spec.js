const { test, expect } = require('@playwright/test');
const { getSessionPage, readSessionTokens } = require('../fixtures/session-auth');

test.setTimeout(420_000);
test.describe.configure({ mode: 'serial' });

function parseWaitTimeoutMs(text) {
  const match = String(text).match(/Wait time\s*(?:(\d+)m)?(?:(\d+)s)?/i);
  if (!match) return 0;
  return (Number(match[1] || 0) * 60 + Number(match[2] || 0) + 5) * 1000;
}

async function requestOtpToken(request) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await request.post(`${process.env.PLATFORM_API_BASE_URL}/v1/payout-platform/auth/request-otp-email`, {
      data: {
        email: process.env.PLATFORM_USER_EMAIL,
        password: process.env.PLATFORM_USER_PASSWORD,
      },
      timeout: 45_000,
    });
    const text = await response.text();
    if (response.ok()) return JSON.parse(text).result.temp_token;

    const waitMs = parseWaitTimeoutMs(text);
    if (waitMs && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    expect(response, `request OTP email failed: ${text}`).toBeOK();
  }
  throw new Error('Unable to request OTP token.');
}

async function apiLogin(request) {
  const saved = readSessionTokens();
  if (saved.accessToken) return saved.accessToken;

  const tempToken = await requestOtpToken(request);
  const response = await request.post(`${process.env.PLATFORM_API_BASE_URL}/v1/payout-platform/auth/login`, {
    data: {
      email: process.env.PLATFORM_USER_EMAIL,
      temp_token: tempToken,
      otp_code: process.env.PLATFORM_EMAIL_OTP,
    },
    timeout: 45_000,
  });
  await expect(response, 'login via API for UI setup').toBeOK();
  return (await response.json()).result.access_token;
}

function apiHeaders(token) {
  return {
    Authorization: token,
    Accept: 'application/json',
  };
}

async function apiGet(request, token, endpoint, params = {}) {
  const response = await request.get(`${process.env.PLATFORM_API_BASE_URL}${endpoint}`, {
    params,
    headers: apiHeaders(token),
    timeout: 60_000,
  });
  await expect(response, `GET ${endpoint}`).toBeOK();
  return response.json();
}

async function apiPost(request, token, endpoint, data = {}) {
  const response = await request.post(`${process.env.PLATFORM_API_BASE_URL}${endpoint}`, {
    data,
    headers: apiHeaders(token),
    timeout: 60_000,
  });
  await expect(response, `POST ${endpoint}`).toBeOK();
  return response.json();
}

async function requestBatchApprovalOtp(request, token, batchUuid) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await request.post(`${process.env.PLATFORM_API_BASE_URL}/v1/payout-platform/batch/otp/request`, {
      data: { batch_uuid: batchUuid },
      headers: apiHeaders(token),
      timeout: 60_000,
    });
    const text = await response.text();
    if (response.ok()) return JSON.parse(text);

    const waitMs = parseWaitTimeoutMs(text);
    if (waitMs && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    expect(response, `request batch approval OTP failed: ${text}`).toBeOK();
  }
  throw new Error('Unable to request batch approval OTP.');
}

async function loginUi(page, request) {
  await page.goto('/dashboard');
  if (!page.url().includes('/login')) return;

  await page.getByRole('textbox', { name: /Email/i }).fill(process.env.PLATFORM_USER_EMAIL);
  await page.getByRole('textbox', { name: /Password/i }).fill(process.env.PLATFORM_USER_PASSWORD);
  await page.getByRole('button', { name: 'Send OTP' }).click();

  await page.waitForURL(/\/otp/, { timeout: 35_000 }).catch(async () => {
    const existingOtp = page.getByRole('button', { name: 'Enter existing OTP code' });
    if (await existingOtp.isVisible().catch(() => false)) {
      await existingOtp.click();
      await page.waitForURL(/\/otp/, { timeout: 20_000 }).catch(() => {});
    }
    if (!page.url().includes('/otp')) {
      const tempToken = await requestOtpToken(request);
      await page.evaluate(
        ({ email, tempToken }) => localStorage.setItem('pp.temp_auth', JSON.stringify({ email, temp_token: tempToken })),
        { email: process.env.PLATFORM_USER_EMAIL, tempToken },
      );
      await page.goto('/otp');
    }
  });

  await page.getByRole('textbox').first().fill(process.env.PLATFORM_EMAIL_OTP);
  const verify = page.getByRole('button', { name: /Verify/i });
  if (await verify.isEnabled().catch(() => false)) await verify.click();
  await page.waitForURL((url) => !url.pathname.includes('/login') && !url.pathname.includes('/otp'), { timeout: 60_000 });
}

async function firstEftDestination(request, token) {
  const body = await apiGet(request, token, '/v1/payout-platform/beneficiary/destination-list', {
    status: 'approved',
    disabled: false,
    per_page: 20,
  });
  const destination = (body.result.list || []).find((item) => item.rail === 'eft' && item.destination_uuid);
  expect(destination, 'approved EFT destination').toBeTruthy();
  return destination;
}

async function createBatch(request, token, label, runId, extra = {}) {
  const body = await apiPost(request, token, '/v1/payout-platform/batch/create', {
    name: `Codex UI Test ${label} ${runId}`,
    client_batch_reference: `CODEX-UI-TEST-${label.toUpperCase().replace(/\s+/g, '-')}-${runId}`,
    ...extra,
  });
  return body.result.batch;
}

async function addLine(request, token, batchUuid, destination, runId) {
  const body = await apiPost(request, token, '/v1/payout-platform/batch/draft-line/add', {
    batch_uuid: batchUuid,
    destination_uuid: destination.destination_uuid,
    amount: '11.00',
    reference: `Codex UI test ${runId}`,
    internal_reference: `CODEX-UI-TEST-${runId}`,
  });
  return body.result.batch;
}

async function detail(request, token, batchUuid) {
  const body = await apiGet(request, token, '/v1/payout-platform/batch/get-by-uuid', {
    batch_uuid: batchUuid,
    include_items: true,
  });
  return body.result.batch;
}

async function submit(request, token, batchUuid) {
  const body = await apiPost(request, token, '/v1/payout-platform/batch/status/submit', {
    batch_uuid: batchUuid,
    force_submit: true,
  });
  return body.result.batch;
}

async function createSubmitted(request, token, destination, label, runId) {
  const batch = await createBatch(request, token, label, runId);
  await addLine(request, token, batch.batch_uuid, destination, runId);
  await submit(request, token, batch.batch_uuid);
  return detail(request, token, batch.batch_uuid);
}

async function approve(request, token, batchUuid) {
  await requestBatchApprovalOtp(request, token, batchUuid);
  const body = await apiPost(request, token, '/v1/payout-platform/batch/approve', {
    batch_uuid: batchUuid,
    email_otp: process.env.PLATFORM_EMAIL_OTP,
    phone_otp: process.env.PLATFORM_APPROVAL_PHONE_OTP,
    force_approve: true,
  });
  return body.result.batch;
}

test.describe('Batch state pages', () => {
  test.skip(process.env.PLATFORM_ENV !== 'stage', 'Batch UI state smoke coverage is currently approved only for stage/preprod2.');
  test.skip(process.env.ALLOW_MUTATING_BATCH_TESTS !== 'true', 'Set ALLOW_MUTATING_BATCH_TESTS=true to create and mutate real stage batches.');

  let token;
  let page;
  let batches;

  test.beforeAll(async ({ browser, request }) => {
    const runId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    token = await apiLogin(request);
    const destination = await firstEftDestination(request, token);

    const draft = await createBatch(request, token, 'Draft State', runId);
    const submitted = await createSubmitted(request, token, destination, 'Submitted State', runId);
    const returned = await createSubmitted(request, token, destination, 'Returned State', runId);
    const returnedLine = (returned.line_items || [])[0];
    await apiPost(request, token, '/v1/payout-platform/batch/line/mark-for-edit', {
      line_uuid: returnedLine.line_uuid,
      reason: 'Codex UI test returned state',
    });
    await apiPost(request, token, '/v1/payout-platform/batch/status/return-for-edit', {
      batch_uuid: returned.batch_uuid,
      reason: 'Codex UI test returned state',
    });

    const cancelled = await createSubmitted(request, token, destination, 'Cancelled State', runId);
    await apiPost(request, token, '/v1/payout-platform/batch/status/cancel', {
      batch_uuid: cancelled.batch_uuid,
      reason: 'Codex UI test cancelled state',
    });

    const scheduled = await createBatch(request, token, 'Scheduled State', runId, {
      scheduled_at_sast: '2026-12-18 15:30:00',
    });
    await addLine(request, token, scheduled.batch_uuid, destination, runId);
    await submit(request, token, scheduled.batch_uuid);
    await approve(request, token, scheduled.batch_uuid);

    batches = { draft, submitted, returned, cancelled, scheduled };

    page = await getSessionPage(browser);
    await loginUi(page, request);
  });

  test.afterAll(async ({ request }) => {
    if (token && batches?.submitted) {
      await apiPost(request, token, '/v1/payout-platform/batch/status/cancel', {
        batch_uuid: batches.submitted.batch_uuid,
        reason: 'Codex UI test submitted cleanup cancel',
      }).catch(() => {});
    }
    if (token && batches?.returned) {
      await apiPost(request, token, '/v1/payout-platform/batch/status/submit', {
        batch_uuid: batches.returned.batch_uuid,
        force_submit: true,
      }).catch(() => {});
      await apiPost(request, token, '/v1/payout-platform/batch/status/cancel', {
        batch_uuid: batches.returned.batch_uuid,
        reason: 'Codex UI test returned cleanup cancel',
      }).catch(() => {});
    }
    if (token && batches?.scheduled) {
      await apiPost(request, token, '/v1/payout-platform/batch/status/scheduled-cancel', {
        batch_uuid: batches.scheduled.batch_uuid,
        reason: 'Codex UI test scheduled cleanup to submitted',
      }).catch(() => {});
      await apiPost(request, token, '/v1/payout-platform/batch/status/cancel', {
        batch_uuid: batches.scheduled.batch_uuid,
        reason: 'Codex UI test scheduled cleanup cancel',
      }).catch(() => {});
    }
    if (token && batches?.draft) {
      await apiPost(request, token, '/v1/payout-platform/batch/status/mark-deleted', {
        batch_uuid: batches.draft.batch_uuid,
        reason: 'Codex UI test draft cleanup mark deleted',
      }).catch(() => {});
    }
  });

  test('shows draft batch entry actions and empty-batch guard', async () => {
    await page.goto(`/payouts/${batches.draft.batch_uuid}/draft`);

    await expect(page.getByRole('heading', { name: batches.draft.name })).toBeVisible();
    await expect(page.getByText('DRAFT', { exact: true })).toBeVisible();
    await expect(page.getByText('Empty batch')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send for Approval' })).toBeVisible();
  });

  test('shows submitted approval actions', async () => {
    await page.goto(`/approvals/${batches.submitted.batch_uuid}/review`);

    await expect(page.getByRole('heading', { name: batches.submitted.name })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Compare with historical' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Return batch for edit' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  });

  test('shows returned edit actions and reason', async () => {
    await page.goto(`/payouts/${batches.returned.batch_uuid}/edit`);

    await expect(page.getByRole('heading', { name: batches.returned.name })).toBeVisible();
    await expect(page.getByText('RETURNED FOR EDIT', { exact: true })).toBeVisible();
    await expect(page.getByText('Codex UI test returned state').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resend For Approval' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit line' })).toBeVisible();
  });

  test('shows cancelled and scheduled batches in History', async () => {
    await page.goto(`/history?q=${encodeURIComponent(batches.cancelled.name)}`);
    const cancelledRow = page.getByRole('row').filter({ hasText: batches.cancelled.name }).first();
    await expect(cancelledRow).toBeVisible();
    await expect(cancelledRow.getByText('cancelled', { exact: true })).toBeVisible();
    await expect(cancelledRow.getByRole('button', { name: 'Open' })).toBeVisible();

    await page.goto(`/history?q=${encodeURIComponent(batches.scheduled.name)}`);
    const scheduledRow = page.getByRole('row').filter({ hasText: batches.scheduled.name }).first();
    await expect(scheduledRow).toBeVisible();
    await expect(scheduledRow.getByText('Scheduled at 2026-12-18 15:30')).toBeVisible();
    await expect(scheduledRow.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(scheduledRow.getByRole('button', { name: 'Open' })).toBeVisible();
  });
});
