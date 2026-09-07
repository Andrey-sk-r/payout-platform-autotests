const fs = require('node:fs/promises');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { getSessionPage, readSessionTokens } = require('../fixtures/session-auth');

test.setTimeout(180_000);

const historyBeneficiaryPath = path.resolve(__dirname, '..', '..', '.auth', 'history-beneficiary.json');

function parseWaitTimeoutMs(text) {
  const match = text.match(/Wait time\s*(?:(\d+)m)?(?:(\d+)s)?/i);
  return match ? (Number(match[1] || 0) * 60 + Number(match[2] || 0) + 5) * 1000 : 0;
}

async function requestOtpToken(request) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await request.post(`${process.env.PLATFORM_API_BASE_URL}/v1/payout-platform/auth/request-otp-email`, {
      data: {
        email: process.env.PLATFORM_USER_EMAIL,
        password: process.env.PLATFORM_USER_PASSWORD,
      },
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

async function login(page, request) {
  await page.goto('/dashboard');
  if (!page.url().includes('/login')) return readSessionTokens();

  await page.getByRole('textbox', { name: /Email/i }).fill(process.env.PLATFORM_USER_EMAIL);
  await page.getByRole('textbox', { name: /Password/i }).fill(process.env.PLATFORM_USER_PASSWORD);
  await page.getByRole('button', { name: 'Send OTP' }).click();

  try {
    await page.waitForURL(/\/otp/, { timeout: 35_000 });
  } catch {
    const existingOtp = page.getByRole('button', { name: 'Enter existing OTP code' });
    await existingOtp.waitFor({ timeout: 20_000 });
    await existingOtp.click();
    try {
      await page.waitForURL(/\/otp/, { timeout: 30_000 });
    } catch {
      const tempToken = await requestOtpToken(request);
      await page.evaluate(
        ({ email, tempToken }) => {
          localStorage.setItem('pp.temp_auth', JSON.stringify({ email, temp_token: tempToken }));
        },
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
    await page.waitForURL((url) => !url.pathname.includes('/otp') && !url.pathname.includes('/login'), { timeout: 12_000 });
  } catch {
    const verifyButton = page.getByRole('button', { name: /Verify/i });
    if (await verifyButton.isEnabled().catch(() => false)) await verifyButton.click();
    await page.waitForURL((url) => !url.pathname.includes('/otp') && !url.pathname.includes('/login'), { timeout: 45_000 });
  }

  return readSessionTokens();
}

async function apiJson(request, accessToken, method, pathName, data) {
  const retryDelays = [5_000, 15_000, 30_000];
  let response;
  let text;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    const options = {
      headers: { Authorization: accessToken, Accept: 'application/json' },
      timeout: 30_000,
    };
    if (method === 'get') options.params = data;
    else options.data = data;

    try {
      response = await request[method](`${process.env.PLATFORM_API_BASE_URL}${pathName}`, options);
      text = await response.text();
    } catch (error) {
      const transientNetworkError = /socket hang up|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(error.message || '');
      if (!transientNetworkError || attempt === retryDelays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
      continue;
    }
    if (response.status() !== 429 || attempt === retryDelays.length) break;
    await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
  }

  expect(response.ok(), `${method.toUpperCase()} ${pathName}: ${response.status()} ${text}`).toBeTruthy();
  return text ? JSON.parse(text) : {};
}

function resultEntity(body, key) {
  return body?.result?.[key] || body?.result || {};
}

function entityUuid(entity, name) {
  return entity?.[`${name}_uuid`] || entity?.uuid;
}

function isoDate(value) {
  const date = new Date(value);
  expect(Number.isNaN(date.getTime()), `valid history date from ${value}`).toBeFalsy();
  return date.toISOString().slice(0, 10);
}

function previousIsoDate(dateText) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

async function createHistoryFixture(request, accessToken, generated) {
  const suffix = Date.now();
  const { displayName, beneficiaryUuid, destinationUuid } = generated;

  const batches = [];
  for (const index of [1, 2]) {
    const name = `Codex History Range ${index} ${suffix}`;
    const createBody = await apiJson(request, accessToken, 'post', '/v1/payout-platform/batch/create', {
      name,
      client_batch_reference: `CODEX-HISTORY-${index}-${suffix}`,
    });
    const createdBatch = resultEntity(createBody, 'batch');
    const batchUuid = entityUuid(createdBatch, 'batch');
    expect(batchUuid, `created history batch ${index} uuid`).toBeTruthy();

    await apiJson(request, accessToken, 'post', '/v1/payout-platform/batch/draft-line/add', {
      batch_uuid: batchUuid,
      destination_uuid: destinationUuid,
      amount: `${10 * index}.00`,
      reference: `History range ${index} ${suffix}`,
      internal_reference: `CODEX-HISTORY-${index}-${suffix}`,
    });
    await apiJson(request, accessToken, 'post', '/v1/payout-platform/batch/status/submit', {
      batch_uuid: batchUuid,
      force_submit: true,
    });
    const cancelBody = await apiJson(request, accessToken, 'post', '/v1/payout-platform/batch/status/cancel', {
      batch_uuid: batchUuid,
      reason: `History range fixture ${suffix}`,
    });
    batches.push({ name, batch: resultEntity(cancelBody, 'batch') });
  }

  const updatedValue = batches[0].batch.updated_at
    || batches[0].batch.updated_date
    || batches[0].batch.modified_at
    || batches[0].batch.created_at;
  const historyDate = isoDate(updatedValue);

  return {
    beneficiaryUuid,
    destinationUuid,
    displayName,
    batchNames: batches.map(({ name }) => name),
    historyDate,
    emptyDate: previousIsoDate(historyDate),
  };
}

async function visibleHistoryRows(page) {
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(500);
  return page.getByRole('row').evaluateAll((rows) =>
    rows
      .map((row) => row.innerText)
      .filter((text) => text && !text.startsWith('Name\t')),
  );
}

async function openHistory(page, params) {
  const query = new URLSearchParams(params);
  await page.goto(`/history?${query.toString()}`);
  await expect(page.getByRole('heading', { name: 'History' }).first()).toBeVisible();
  return visibleHistoryRows(page);
}

test.describe('History beneficiary search with date range', () => {
  test.describe.configure({ mode: 'serial' });

  let page;
  let requestContext;
  let accessToken;
  let fixture;

  test.beforeAll(async ({ browser, request }, testInfo) => {
    testInfo.setTimeout(180_000);
    test.skip(process.env.PLATFORM_ENV !== 'stage', 'Dynamic History fixture is approved only for stage/preprod2.');
    test.skip(process.env.ALLOW_MUTATING_BATCH_TESTS !== 'true', 'Set ALLOW_MUTATING_BATCH_TESTS=true to create History fixtures.');
    page = await getSessionPage(browser);
    const tokens = await login(page, request);
    requestContext = request;
    accessToken = tokens.access_token;
    const generated = await fs.readFile(historyBeneficiaryPath, 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    test.skip(
      !generated?.beneficiaryUuid || !generated?.displayName || !generated?.destinationUuid,
      'History requires the beneficiary and approved destination created by beneficiaries.ui.spec.js in this run.',
    );
    fixture = await createHistoryFixture(request, accessToken, generated);
  });

  test.afterAll(async () => {
    if (requestContext && accessToken && fixture?.destinationUuid) {
      await requestContext.post(`${process.env.PLATFORM_API_BASE_URL}/v1/payout-platform/beneficiary/destination/delete-destination`, {
        headers: { Authorization: accessToken, Accept: 'application/json' },
        data: {
          destination_uuid: fixture.destinationUuid,
          reason: 'History UI automation cleanup',
        },
        timeout: 30_000,
      }).catch(() => null);
    }
    await fs.rm(historyBeneficiaryPath, { force: true });
  });

  test('filters created history batches by beneficiary and their actual updated date', async () => {
    const rows = await openHistory(page, {
      beneficiary: fixture.displayName,
      process_date_from: fixture.historyDate,
      process_date_to: fixture.historyDate,
    });

    expect(rows).toHaveLength(2);
    for (const batchName of fixture.batchNames) expect(rows.join('\n')).toContain(batchName);
  });

  test('shows empty state for the created beneficiary outside its actual updated date', async () => {
    const rows = await openHistory(page, {
      beneficiary: fixture.displayName,
      process_date_from: fixture.emptyDate,
      process_date_to: fixture.emptyDate,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('No history batches found');
  });

  test('includes created rows when the actual updated date is both range boundaries', async () => {
    const rows = await openHistory(page, {
      beneficiary: fixture.displayName,
      process_date_from: fixture.historyDate,
      process_date_to: fixture.historyDate,
    });

    for (const batchName of fixture.batchNames) expect(rows.join('\n')).toContain(batchName);
  });
});
