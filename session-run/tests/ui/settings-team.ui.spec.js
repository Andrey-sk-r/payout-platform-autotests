const fs = require('node:fs/promises');
const path = require('node:path');
const { test, expect, request: playwrightRequest } = require('@playwright/test');
const { getSessionPage, readSessionTokens } = require('../fixtures/session-auth');

test.setTimeout(420_000);

const artifactDir = path.resolve(__dirname, '..', '..', 'test-results', 'captures', 'settings-team');
const runStamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

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

async function apiRequest(api, method, accessToken, pathName, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await api[method](`${process.env.PLATFORM_API_BASE_URL}${pathName}`, {
        headers: { Authorization: accessToken, Accept: 'application/json' },
        ...options,
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

async function apiPost(api, accessToken, pathName, data) {
  return apiRequest(api, 'post', accessToken, pathName, { data });
}

async function apiGet(api, accessToken, pathName, params) {
  return apiRequest(api, 'get', accessToken, pathName, { params });
}

async function findUserByEmail(api, accessToken, email) {
  const response = await apiGet(api, accessToken, '/v1/payout-platform/org-user/get-list');
  await expect(response, 'org user get-list').toBeOK();
  const body = await response.json();
  const list = body?.result?.list || [];
  return list.find((user) => user.email === email);
}

async function waitForUserByEmail(api, accessToken, email) {
  let user;
  await expect.poll(async () => {
    user = await findUserByEmail(api, accessToken, email);
    return Boolean(user);
  }, { timeout: 30_000 }).toBeTruthy();
  return user;
}

function userUuidFromInviteBody(body) {
  return body?.result?.user?.user_uuid
    || body?.result?.org_user?.user_uuid
    || body?.result?.user_uuid
    || body?.user_uuid;
}

async function screenshot(page, name) {
  await fs.mkdir(artifactDir, { recursive: true });
  await page.screenshot({
    path: path.join(artifactDir, `${runStamp}-${name}.png`),
    fullPage: true,
  });
}

async function waitForOrgUserRequest(page, endpoint, action) {
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes(`/org-user/${endpoint}`),
    { timeout: 30_000 },
  );
  await action();
  return responsePromise;
}

async function teamRow(page, email) {
  return page.getByRole('row').filter({ hasText: email }).first();
}

async function openTeam(page) {
  await page.goto('/settings/team');
  await expect(page).toHaveURL(/\/settings\/team$/);
  await expect(page.getByRole('heading', { name: 'Team Members' })).toBeVisible();
}

test.describe.serial('Settings Team UI', () => {
  let page;
  let api;
  let accessToken;
  let userUuid;
  const suffix = Date.now();
  const email = `stage.team.ui.${suffix}@email.com`;
  const updatedEmail = `stage.team.ui.updated.${suffix}@email.com`;
  const phone = `2783${String(suffix).slice(-7)}`;

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(420_000);
    api = await playwrightRequest.newContext();
    page = await getSessionPage(browser);
    const tokenPair = await login(page, api);
    accessToken = tokenPair.access_token;
  });

  test.afterAll(async () => {
    const user = userUuid
      ? { user_uuid: userUuid }
      : await findUserByEmail(api, accessToken, email).catch(() => null)
        || await findUserByEmail(api, accessToken, updatedEmail).catch(() => null);

    if (user?.user_uuid) {
      await apiPost(api, accessToken, '/v1/payout-platform/org-user/disable', {
        user_uuid: user.user_uuid,
        reason: 'Automated stage cleanup',
      }).catch(() => null);
    }
    await api?.dispose();
  });

  test('TEAM-UI-001: team page renders list and invite modal validation', async () => {
    await openTeam(page);
    await screenshot(page, 'team-list');

    await expect(page.getByPlaceholder('Search by name or email')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Member' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Roles' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Status' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Actions' })).toBeVisible();

    await page.getByRole('button', { name: 'Invite User' }).click();
    const dialog = page.getByRole('dialog', { name: 'Invite User' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Invite' }).click();
    await expect(dialog.getByText('First name is required')).toBeVisible();
    await expect(dialog.getByText('Last name is required')).toBeVisible();
    await expect(dialog.getByText('Email is required')).toBeVisible();
    await expect(dialog.getByText('At least one role is required')).toBeVisible();
    await screenshot(page, 'invite-validation');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('TEAM-UI-002: invite user creates pending row and supports re-invite', async () => {
    await openTeam(page);
    await page.getByRole('button', { name: 'Invite User' }).click();
    const dialog = page.getByRole('dialog', { name: 'Invite User' });
    await dialog.getByRole('textbox', { name: 'First Name' }).fill('Lerato');
    await dialog.getByRole('textbox', { name: 'Last Name' }).fill('Nkosi');
    await dialog.getByRole('textbox', { name: 'Email' }).fill(email);
    await dialog.getByRole('textbox', { name: 'Phone' }).fill(phone);
    await dialog.getByText('Maker').click();

    const inviteResponse = await waitForOrgUserRequest(
      page,
      'invite',
      () => dialog.getByRole('button', { name: 'Invite' }).click(),
    );
    expect(inviteResponse.ok(), 'invite user').toBeTruthy();
    const inviteBody = await inviteResponse.json().catch(() => ({}));
    userUuid = userUuidFromInviteBody(inviteBody) || userUuid;

    const user = await waitForUserByEmail(api, accessToken, email);
    userUuid = user.user_uuid || userUuid;

    await page.getByPlaceholder('Search by name or email').fill(email);
    const row = await teamRow(page, email);
    await expect(row).toBeVisible();
    await expect(row).toContainText('Pending');
    await expect(row).toContainText('Maker');
    await screenshot(page, 'invited-pending-row');

    const resendResponse = await waitForOrgUserRequest(
      page,
      'resend-invite',
      () => row.getByText('Re-Invite', { exact: true }).click({ timeout: 10_000 }),
    );
    expect(resendResponse.ok(), 'resend invite').toBeTruthy();
  });

  test('TEAM-UI-003: edit user updates row data', async () => {
    await openTeam(page);
    await page.getByPlaceholder('Search by name or email').fill(email);
    const row = await teamRow(page, email);
    await expect(row).toBeVisible();

    await row.getByLabel('User actions').click();
    await page.getByRole('menuitem', { name: 'Edit user' }).click();
    const dialog = page.getByRole('dialog', { name: 'Update User' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'First Name' }).fill('Zanele');
    await dialog.getByRole('textbox', { name: 'Email' }).fill(updatedEmail);
    await dialog.getByText('Checker').click();
    await screenshot(page, 'edit-user-form');

    const updateResponse = await waitForOrgUserRequest(
      page,
      'update',
      () => dialog.getByRole('button', { name: 'Update' }).click(),
    );
    expect(updateResponse.ok(), 'update user').toBeTruthy();

    await waitForUserByEmail(api, accessToken, updatedEmail);
    await page.getByPlaceholder('Search by name or email').fill(updatedEmail);
    const updatedRow = await teamRow(page, updatedEmail);
    await expect(updatedRow).toBeVisible();
    await expect(updatedRow).toContainText('Zanele');
    await expect(updatedRow).toContainText('Checker');
  });

  test('TEAM-UI-004: disable user action updates status', async () => {
    await openTeam(page);
    await page.getByPlaceholder('Search by name or email').fill(updatedEmail);
    let row = await teamRow(page, updatedEmail);
    await expect(row).toBeVisible();

    await row.getByLabel('User actions').click();
    await page.getByRole('menuitem', { name: 'Disable user' }).click();
    await page.getByPlaceholder('Provide a reason for disabling...').fill('Automated stage cleanup');
    await screenshot(page, 'disable-user-form');

    const disableResponse = await waitForOrgUserRequest(
      page,
      'disable',
      () => page.getByRole('button', { name: 'Disable user' }).click(),
    );
    expect(disableResponse.ok(), 'disable user').toBeTruthy();

    row = await teamRow(page, updatedEmail);
    await expect(row).toContainText('Disabled');
    await screenshot(page, 'disabled-user-row');

    await apiPost(api, accessToken, '/v1/payout-platform/org-user/disable', {
      user_uuid: userUuid,
      reason: 'Automated stage cleanup',
    });
  });
});
