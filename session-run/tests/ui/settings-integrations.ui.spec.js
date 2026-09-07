const { test, expect, request: playwrightRequest } = require('@playwright/test');
const { getSessionPage, readSessionTokens } = require('../fixtures/session-auth');

test.setTimeout(240_000);

function parseWaitTimeoutMs(text) {
  const match = text.match(/Wait time\s*(?:(\d+)m)?(?:(\d+)s)?/i);
  return match ? (Number(match[1] || 0) * 60 + Number(match[2] || 0) + 5) * 1000 : 0;
}

async function requestOtpToken(api) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await api.post(`${process.env.PLATFORM_API_BASE_URL}/v1/payout-platform/auth/request-otp-email`, {
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

async function login(page, api) {
  await page.goto('/dashboard');
  if (!page.url().includes('/login')) return readSessionTokens();

  let tokenPair;
  page.on('response', async (response) => {
    if (response.url().endsWith('/v1/payout-platform/auth/login') && response.ok()) {
      const body = await response.json();
      tokenPair = body.result;
    }
  });

  await page.goto('/login');
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
      const tempToken = await requestOtpToken(api);
      await page.evaluate(
        ({ email, tempToken }) => localStorage.setItem('pp.temp_auth', JSON.stringify({ email, temp_token: tempToken })),
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
    const verify = page.getByRole('button', { name: /Verify/i });
    if (await verify.isEnabled().catch(() => false)) await verify.click();
    await page.waitForURL((url) => !url.pathname.includes('/otp') && !url.pathname.includes('/login'), { timeout: 45_000 });
  }
  await expect.poll(() => tokenPair?.access_token).toBeTruthy();
  return tokenPair;
}

async function apiPost(api, accessToken, path, data) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await api.post(`${process.env.PLATFORM_API_BASE_URL}${path}`, {
        headers: { Authorization: accessToken, Accept: 'application/json' },
        data,
      });
    } catch (error) {
      lastError = error;
      if (!/socket hang up|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(error.message || '') || attempt === 2) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 5_000));
    }
  }
  throw lastError;
}

async function apiGet(api, accessToken, path, params) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await api.get(`${process.env.PLATFORM_API_BASE_URL}${path}`, {
        headers: { Authorization: accessToken, Accept: 'application/json' },
        params,
      });
    } catch (error) {
      lastError = error;
      if (!/socket hang up|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(error.message || '') || attempt === 2) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 5_000));
    }
  }
  throw lastError;
}

async function waitForListRequest(page, predicate, action) {
  const responsePromise = page.waitForResponse((response) => {
    if (!response.url().includes('/provider-credential/get-list')) return false;
    const params = new URL(response.url()).searchParams;
    return predicate(params);
  });
  await action();
  return responsePromise;
}

async function integrationRow(page, name) {
  return page.getByRole('row').filter({ hasText: name }).first();
}

test.describe.serial('Settings Integrations', () => {
  let page;
  let api;
  let accessToken;
  let uuid;
  let deleted = false;
  const suffix = Date.now();
  const initialName = `QA Payroll Sync ${suffix}`;
  const updatedName = `QA Payroll Sync Updated ${suffix}`;
  const initialClientId = `qa-payroll-${suffix}`;

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(240_000);
    api = await playwrightRequest.newContext();
    page = await getSessionPage(browser);
    const tokenPair = await login(page, api);
    accessToken = tokenPair.access_token;

    const response = await apiPost(api, accessToken, '/v1/payout-platform/provider-credential/create', {
      provider_code: 'simplepay',
      name: initialName,
      client_id: initialClientId,
      api_key: `qa-api-key-${suffix}`,
      is_active: true,
    });
    expect(response, 'create disposable integration').toBeOK();
    const body = await response.json();
    uuid = body.result.credential.uuid;
  });

  test.afterAll(async () => {
    if (uuid && !deleted) {
      await apiPost(api, accessToken, '/v1/payout-platform/provider-credential/delete', { uuid });
    }
    await api?.dispose();
  });

  test('INT-UI-001: integrations page opens from route', async () => {
    await page.goto('/settings/integrations');
    await expect(page).toHaveURL(/\/settings\/integrations$/);
    await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible();
  });

  test('INT-UI-002: table and default pagination are rendered', async () => {
    const response = await waitForListRequest(
      page,
      (params) => params.get('limit') === '50' && params.get('offset') === '0',
      () => page.reload(),
    );
    expect(response.ok()).toBeTruthy();
    await expect(page.getByRole('columnheader', { name: 'Provider' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Name' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Client ID' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Status' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Created at' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Updated at' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Per page' })).toHaveText('50');
  });

  test('INT-UI-003: name filter is sent to get-list', async () => {
    const response = await waitForListRequest(
      page,
      (params) => params.get('name') === initialName,
      () => page.getByPlaceholder('Search by name').fill(initialName),
    );
    expect(response.ok()).toBeTruthy();
    await expect(await integrationRow(page, initialName)).toBeVisible();
  });

  test('INT-UI-004: provider_code and is_active filters are sent to get-list', async () => {
    await page.getByPlaceholder('Search by name').fill('');
    await waitForListRequest(
      page,
      (params) => params.get('provider_code') === 'simplepay',
      async () => {
        await page.getByRole('button', { name: 'Provider filter' }).click();
        await page.getByRole('option', { name: 'SimplePay' }).click();
      },
    );
    const response = await waitForListRequest(
      page,
      (params) => params.get('provider_code') === 'simplepay' && params.get('is_active') === 'true',
      async () => {
        await page.getByRole('button', { name: 'Status filter' }).click();
        await page.getByRole('option', { name: 'Active', exact: true }).click();
      },
    );
    expect(response.ok()).toBeTruthy();
  });

  test('INT-UI-005: changing page size sends limit and resets offset', async () => {
    const response = await waitForListRequest(
      page,
      (params) => params.get('limit') === '15' && params.get('offset') === '0',
      async () => {
        await page.getByRole('button', { name: 'Per page' }).click();
        await page.getByRole('option', { name: '15' }).click();
      },
    );
    expect(response.ok()).toBeTruthy();
  });

  test('INT-UI-006: Add Integration modal is available for admin', async () => {
    await waitForListRequest(
      page,
      (params) => !params.has('is_active'),
      async () => {
        await page.getByRole('button', { name: 'Status filter' }).click();
        await page.getByRole('option', { name: 'All statuses' }).click();
      },
    );
    await page.getByRole('button', { name: 'Add Integration' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add integration' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByPlaceholder('Friendly name for this integration')).toBeVisible();
    await expect(dialog.getByPlaceholder('Paste the SimplePay API key')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('INT-UI-007: edit action updates integration and refetches list', async () => {
    await waitForListRequest(
      page,
      (params) => params.get('name') === initialName,
      () => page.getByPlaceholder('Search by name').fill(initialName),
    );
    const row = await integrationRow(page, initialName);
    await expect(row).toBeVisible();
    await row.getByLabel('Integration actions').click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit integration' });
    await dialog.getByPlaceholder('Friendly name for this integration').fill(updatedName);
    const response = await waitForListRequest(
      page,
      (params) => params.get('name') === initialName,
      () => dialog.getByRole('button', { name: 'Save changes' }).click(),
    );
    expect(response.ok()).toBeTruthy();
    await waitForListRequest(
      page,
      (params) => params.get('name') === updatedName,
      () => page.getByPlaceholder('Search by name').fill(updatedName),
    );
    await expect(await integrationRow(page, updatedName)).toBeVisible();
  });

  test('INT-UI-008: rotate API key action refetches list', async () => {
    const row = await integrationRow(page, updatedName);
    await row.getByLabel('Integration actions').click();
    await page.getByRole('menuitem', { name: 'Rotate API key' }).click();
    const dialog = page.getByRole('dialog', { name: 'Rotate API key' });
    await dialog.getByPlaceholder('Paste the new API key').fill(`qa-api-key-rotated-${suffix}`);
    const response = await waitForListRequest(page, () => true, () => dialog.getByRole('button', { name: 'Rotate key' }).click());
    expect(response.ok()).toBeTruthy();
  });

  test('INT-UI-009: toggle active action refetches list', async () => {
    const row = await integrationRow(page, updatedName);
    const toggle = row.getByRole('switch', { name: `Toggle ${updatedName} integration` });
    await expect(toggle).toBeChecked();
    const response = await waitForListRequest(
      page,
      (params) => params.get('name') === updatedName,
      () => toggle.click({ force: true }),
    );
    expect(response.ok()).toBeTruthy();
    await expect(toggle).not.toBeChecked();
  });

  test('INT-UI-010: delete action removes integration and refetches list', async () => {
    const row = await integrationRow(page, updatedName);
    await row.getByLabel('Integration actions').click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete integration' });
    const response = await waitForListRequest(page, () => true, () => dialog.getByRole('button', { name: 'Delete' }).click());
    expect(response.ok()).toBeTruthy();
    await expect(await integrationRow(page, updatedName)).toHaveCount(0);
    deleted = true;
  });

  test('INT-UI-011: API supports limit and offset pagination', async () => {
    const response = await apiGet(api, accessToken, '/v1/payout-platform/provider-credential/get-list', {
      limit: 1,
      offset: 1,
    });
    expect(response).toBeOK();
    const body = await response.json();
    expect(body.result.list.length).toBeLessThanOrEqual(1);
  });

  test('INT-UI-012: client ID-like UI search is sent as name filter', async () => {
    const response = await waitForListRequest(
      page,
      (params) => params.get('name') === '382188' && !params.has('client_id'),
      () => page.getByPlaceholder('Search by name').fill('382188'),
    );

    expect(response.ok()).toBeTruthy();
  });
});
