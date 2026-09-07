const fs = require('node:fs/promises');
const path = require('node:path');
const { test, expect, request: playwrightRequest } = require('@playwright/test');
const { getSessionPage, readSessionTokens } = require('../fixtures/session-auth');

test.setTimeout(420_000);

const artifactDir = path.resolve(__dirname, '..', '..', 'test-results', 'captures', 'beneficiaries-ui');
const historyBeneficiaryPath = path.resolve(__dirname, '..', '..', '.auth', 'history-beneficiary.json');
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

async function apiGet(api, accessToken, pathName, params) {
  return apiRequest(api, 'get', accessToken, pathName, { params });
}

async function apiPost(api, accessToken, pathName, data) {
  return apiRequest(api, 'post', accessToken, pathName, { data });
}

async function screenshot(page, name) {
  await fs.mkdir(artifactDir, { recursive: true });
  await page.screenshot({
    path: path.join(artifactDir, `${runStamp}-${name}.png`),
    fullPage: true,
  });
}

function beneficiaryPath(response, endpoint) {
  try {
    return new URL(response.url()).pathname === `/v1/payout-platform/beneficiary/${endpoint}`;
  } catch {
    return false;
  }
}

async function waitForBeneficiaryRequest(page, endpoint, action) {
  const responsePromise = page.waitForResponse(
    (response) => beneficiaryPath(response, endpoint),
    { timeout: 30_000 },
  );
  await action();
  return responsePromise;
}

async function createDestinationWithTimeoutRecovery({
  page,
  dialog,
  api,
  accessToken,
  beneficiaryUuid,
  expectedIdentifier,
}) {
  const createButton = dialog.getByRole('button', { name: /^Create$/i });

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await waitForBeneficiaryRequest(
        page,
        'create-destination',
        () => createButton.click(),
      );
    } catch (error) {
      if (!/waitForResponse.*Timeout|Timeout.*waiting for event/i.test(error.message || '')) throw error;

      const destinations = await beneficiaryDestinations(api, accessToken, beneficiaryUuid);
      if (destinations.some((destination) => JSON.stringify(destination).includes(expectedIdentifier))) {
        return null;
      }

      if (attempt === 2) throw error;
      await expect(dialog.getByText(/server did not respond within 30s/i)).toBeVisible({ timeout: 5_000 });
      await expect(createButton).toBeEnabled();
    }
  }

  throw new Error('create destination retry loop exhausted');
}

async function expectResponseOk(response, context) {
  if (!response.ok()) {
    throw new Error(`${context} failed: ${response.status()} ${await response.text()}`);
  }
}

async function openBeneficiaries(page) {
  await page.goto('/beneficiaries');
  await expect(page).toHaveURL(/\/beneficiaries/);
  await expect(page.getByRole('heading', { name: 'Beneficiaries' }).first()).toBeVisible({ timeout: 30_000 });
}

async function searchBeneficiary(page, displayName) {
  const search = page.getByPlaceholder('Search by beneficiary name');
  await search.fill('');
  await search.fill(displayName);
  const row = page.getByRole('row').filter({ hasText: displayName }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row;
}

async function beneficiaryUuidByDisplayName(api, accessToken, displayName) {
  const response = await apiGet(api, accessToken, '/v1/payout-platform/beneficiary/beneficiary-list', {
    display_name: displayName,
    limit: 10,
    offset: 0,
  });
  await expect(response, 'beneficiary-list lookup').toBeOK();
  const body = await response.json();
  const row = (body?.result?.list || []).find((item) => item.display_name === displayName);
  return row?.beneficiary_uuid;
}

function beneficiaryFromCreate(body) {
  return body?.result?.beneficiary?.beneficiary || body?.result?.beneficiary || body?.result || {};
}

function destinationFromCreate(body) {
  return body?.result?.destination || body?.result?.beneficiary_destination || body?.result || {};
}

async function beneficiaryDestinations(api, accessToken, beneficiaryUuid) {
  const response = await apiGet(api, accessToken, '/v1/payout-platform/beneficiary/get-details', {
    beneficiary_uuid: beneficiaryUuid,
  });
  await expectResponseOk(response, 'get beneficiary details');
  const body = await response.json();
  const result = body?.result?.beneficiary || body?.result || {};
  return result.destinations || result.beneficiary?.destinations || result.destination_list || [];
}

async function ensureBeneficiary(api, accessToken, { displayName, comment }) {
  const existingUuid = await beneficiaryUuidByDisplayName(api, accessToken, displayName);
  if (existingUuid) return existingUuid;

  const response = await apiPost(api, accessToken, '/v1/payout-platform/beneficiary/create', {
    display_name: displayName,
    creator_comment: comment,
  });
  await expectResponseOk(response, 'create beneficiary prerequisite');
  const created = beneficiaryFromCreate(await response.json());
  const createdUuid = created.beneficiary_uuid || created.uuid;
  expect(createdUuid, 'prerequisite beneficiary uuid').toBeTruthy();
  return createdUuid;
}

async function ensurePendingDestination(api, accessToken, prerequisite) {
  const uuid = await ensureBeneficiary(api, accessToken, prerequisite);
  const destinations = await beneficiaryDestinations(api, accessToken, uuid);
  if (destinations.some((destination) => destination.status === 'pending')) return uuid;

  const response = await apiPost(api, accessToken, '/v1/payout-platform/beneficiary/create-destination', {
    beneficiary_uuid: uuid,
    rail: 'e-wallet',
    phone_number: prerequisite.phoneNumber,
  });
  await expectResponseOk(response, 'create pending destination prerequisite');
  const created = destinationFromCreate(await response.json());
  expect(created.destination_uuid || created.uuid, 'prerequisite destination uuid').toBeTruthy();
  return uuid;
}

async function ensureApprovedDestination(api, accessToken, prerequisite) {
  const uuid = await ensureBeneficiary(api, accessToken, prerequisite);
  let destinations = await beneficiaryDestinations(api, accessToken, uuid);
  if (destinations.some((destination) => destination.status === 'approved')) return uuid;

  if (!destinations.some((destination) => destination.status === 'pending')) {
    await ensurePendingDestination(api, accessToken, prerequisite);
    destinations = await beneficiaryDestinations(api, accessToken, uuid);
  }
  expect(destinations.some((destination) => destination.status === 'pending'), 'pending prerequisite destination').toBeTruthy();

  const response = await apiPost(
    api,
    accessToken,
    '/v1/payout-platform/beneficiary/destination/approve-pending-bulk-by-beneficiary',
    { beneficiary_uuid: uuid },
  );
  await expectResponseOk(response, 'approve destination prerequisite');
  return uuid;
}

async function selectRail(page, dialog, railText) {
  await dialog.getByRole('button', { name: /Select rail|Rail|Select payment method|Payment method/i }).first().click({ timeout: 10_000 });
  try {
    await page.getByText(new RegExp(`^(${railText})$`, 'i')).last().click({ timeout: 3_000 });
  } catch {
    const value = /payshap/i.test(railText)
      ? 'payshap'
      : /wallet/i.test(railText)
        ? 'e-wallet'
        : railText.toLowerCase();
    await dialog.locator('select').last().selectOption(value);
  }
  await page.keyboard.press('Escape').catch(() => null);
}

function creatorCommentTextbox(dialog) {
  return dialog.getByPlaceholder(/Explain the purpose of this beneficiary/i);
}

function editCommentTextbox(dialog) {
  return dialog.getByRole('textbox', { name: /Comment/i });
}

function detailsDialog(page) {
  return page.getByRole('dialog', { name: /View beneficiary|Beneficiary Details/i });
}

async function waitForDetailsLoaded(page, displayName) {
  const dialog = detailsDialog(page);
  await expect(dialog).toBeVisible({ timeout: 20_000 });

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    if (await dialog.getByText(displayName).isVisible({ timeout: 2_000 }).catch(() => false)) {
      await expect(dialog.getByRole('button', { name: /^Add$/i })).toBeVisible({ timeout: 10_000 });
      return dialog;
    }

    const retry = dialog.getByRole('button', { name: /^Retry$/i });
    if (await retry.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await screenshot(page, `details-rate-limit-retry-${attempt}`);
      await retry.click();
      await page.waitForTimeout(12_000);
      continue;
    }

    await page.waitForTimeout(2_000);
  }

  throw new Error('Beneficiary details did not load after retry attempts');
}

test.describe.serial('Beneficiaries UI actions', () => {
  let page;
  let api;
  let accessToken;
  let beneficiaryUuid;
  const suffix = Date.now();
  const displayName = `Codex UI Beneficiary ${suffix}`;
  const firstPhone = `2782${String(suffix).slice(-7)}`;
  const secondPayShap = `082${String(suffix).slice(-7)}@nedbank`;
  const comment = `Created from UI automation ${suffix}`;
  const updatedComment = `Updated from UI automation ${suffix}`;
  const rejectReason = `Reject pending UI destination ${suffix}`;

  function prerequisite() {
    return { displayName, comment, phoneNumber: firstPhone };
  }

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(420_000);
    await fs.rm(historyBeneficiaryPath, { force: true });
    api = await playwrightRequest.newContext();
    page = await getSessionPage(browser);
    const tokenPair = await login(page, api);
    accessToken = tokenPair.access_token;
  });

  test.afterAll(async () => {
    beneficiaryUuid = beneficiaryUuid || await beneficiaryUuidByDisplayName(api, accessToken, displayName).catch(() => null);
    if (beneficiaryUuid) {
      const destinations = await beneficiaryDestinations(api, accessToken, beneficiaryUuid).catch(() => []);
      const approvedDestination = destinations.find((destination) => destination.status === 'approved');
      const approvedDestinationUuid = approvedDestination?.destination_uuid || approvedDestination?.uuid;
      if (approvedDestinationUuid) {
        await fs.mkdir(path.dirname(historyBeneficiaryPath), { recursive: true });
        await fs.writeFile(historyBeneficiaryPath, JSON.stringify({
          beneficiaryUuid,
          displayName,
          destinationUuid: approvedDestinationUuid,
        }), 'utf8');
      }

      for (const destination of destinations) {
        const destinationUuid = destination.destination_uuid || destination.uuid;
        if (!destinationUuid || destinationUuid === approvedDestinationUuid) continue;
        await apiPost(api, accessToken, '/v1/payout-platform/beneficiary/destination/delete-destination', {
          destination_uuid: destinationUuid,
          reason: 'Automated UI cleanup',
        }).catch(() => null);
      }
    }
    await api?.dispose();
  });

  test('BEN-UI-001: create eWallet beneficiary from New Beneficiary modal', async () => {
    await openBeneficiaries(page);
    await screenshot(page, 'beneficiaries-list');

    await page.getByRole('button', { name: 'New Beneficiary' }).click();
    const dialog = page.getByRole('dialog', { name: /New Beneficiary|Create Beneficiary/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: /Display name/i }).fill(displayName);
    await dialog.getByRole('button', { name: /Add first payment method|Add payment method/i }).click();
    await selectRail(page, dialog, 'eWallet|E-Wallet');
    await dialog.getByRole('textbox', { name: /Mobile Number|Phone Number|phone/i }).fill(firstPhone);
    await creatorCommentTextbox(dialog).fill(comment, { timeout: 10_000 });
    await screenshot(page, 'create-ewallet-filled');

    const createBeneficiaryResponse = await waitForBeneficiaryRequest(
      page,
      'create',
      () => dialog.getByRole('button', { name: /^Create$/ }).click(),
    );
    await expectResponseOk(createBeneficiaryResponse, 'create beneficiary');

    const createResponse = await page.waitForResponse((response) => beneficiaryPath(response, 'create-destination'), { timeout: 30_000 });
    await expectResponseOk(createResponse, 'create beneficiary destination');

    beneficiaryUuid = await beneficiaryUuidByDisplayName(api, accessToken, displayName);
    expect(beneficiaryUuid, 'created beneficiary uuid').toBeTruthy();
    await fs.mkdir(path.dirname(historyBeneficiaryPath), { recursive: true });
    await fs.writeFile(historyBeneficiaryPath, JSON.stringify({ beneficiaryUuid, displayName }), 'utf8');

    const row = await searchBeneficiary(page, displayName);
    await expect(row).toContainText(/Pending/i);
    await expect(row.getByRole('button', { name: /Review/i })).toBeVisible();
    await expect(row.getByRole('button', { name: 'View', exact: true })).toBeVisible();
    await screenshot(page, 'created-pending-row');
  });

  test('BEN-UI-002: approve pending beneficiary destination from Review modal', async () => {
    beneficiaryUuid = await ensurePendingDestination(api, accessToken, prerequisite());
    await openBeneficiaries(page);
    const row = await searchBeneficiary(page, displayName);
    await row.getByRole('button', { name: /Review/i }).click();

    const dialog = page.getByRole('dialog', { name: /Review Beneficiary/i });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/Pending/i);
    await expect(dialog.getByRole('button', { name: /Approve all/i })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Reject all/i })).toBeVisible();
    await screenshot(page, 'review-pending-modal');

    const approveResponse = await waitForBeneficiaryRequest(
      page,
      'destination/approve-pending-bulk-by-beneficiary',
      () => dialog.getByRole('button', { name: /Approve all/i }).click(),
    );
    await expectResponseOk(approveResponse, 'approve pending destination');

    const approvedRow = await searchBeneficiary(page, displayName);
    await expect(approvedRow).toContainText(/Approved/i);
    await expect(approvedRow.getByRole('button', { name: 'View', exact: true })).toBeVisible();
    await expect(approvedRow.getByRole('button', { name: /Review/i })).toHaveCount(0);
    await screenshot(page, 'approved-row');
  });

  test('BEN-UI-003: view, edit comment, upload and delete attachment', async () => {
    beneficiaryUuid = await ensureApprovedDestination(api, accessToken, prerequisite());
    await openBeneficiaries(page);
    const row = await searchBeneficiary(page, displayName);
    await row.getByRole('button', { name: 'View', exact: true }).click();

    const dialog = await waitForDetailsLoaded(page, displayName);
    await screenshot(page, 'details-view');

    await dialog.getByRole('button', { name: /^Edit$/i }).click();
    const commentInput = editCommentTextbox(dialog);
    await commentInput.fill(updatedComment);
    await screenshot(page, 'comment-edit-filled');

    const updateResponse = await waitForBeneficiaryRequest(
      page,
      'update',
      () => dialog.getByRole('button', { name: /^Save$/i }).click(),
    );
    await expectResponseOk(updateResponse, 'update beneficiary comment');
    await expect(dialog).toContainText(updatedComment);

    const upload = dialog.locator('input[type="file"]').first();
    await upload.setInputFiles({
      name: 'beneficiary-ui-note.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
        'base64',
      ),
    });
    await page.waitForResponse((response) => response.url().includes('/beneficiary/document-upload') && response.ok(), { timeout: 30_000 });
    await expect(dialog).toContainText('beneficiary-ui-note.png');
    await screenshot(page, 'attachment-uploaded');

    const deleteResponse = await waitForBeneficiaryRequest(
      page,
      'document-delete',
      () => dialog.getByRole('button', { name: /Delete beneficiary-ui-note\.png/i }).click(),
    );
    await expectResponseOk(deleteResponse, 'delete beneficiary attachment');
    await screenshot(page, 'attachment-deleted');
  });

  test('BEN-UI-004: add PayShap destination and reject pending changes from Review modal', async () => {
    beneficiaryUuid = await ensureApprovedDestination(api, accessToken, prerequisite());
    await openBeneficiaries(page);
    let row = await searchBeneficiary(page, displayName);
    await row.getByRole('button', { name: 'View', exact: true }).click();

    let dialog = await waitForDetailsLoaded(page, displayName);
    const addButton = dialog.getByRole('button', { name: /^Add$/i });
    await addButton.scrollIntoViewIfNeeded();
    await addButton.click({ timeout: 10_000 });
    await selectRail(page, dialog, 'PayShap');
    await dialog.getByPlaceholder(/@nedbank/i).fill(secondPayShap);
    await screenshot(page, 'add-payshap-filled');

    const createDestinationResponse = await createDestinationWithTimeoutRecovery({
      page,
      dialog,
      api,
      accessToken,
      beneficiaryUuid,
      expectedIdentifier: secondPayShap,
    });
    if (createDestinationResponse) {
      await expectResponseOk(createDestinationResponse, 'create PayShap destination');
    }

    await dialog.getByRole('button', { name: /^Close$/i }).last().click();
    row = await searchBeneficiary(page, displayName);
    await expect(row).toContainText(/Pending Changes/i);
    await expect(row.getByRole('button', { name: /Review/i })).toBeVisible();
    await screenshot(page, 'pending-changes-row');

    await row.getByRole('button', { name: /Review/i }).click();
    dialog = page.getByRole('dialog', { name: /Review Beneficiary/i });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/Pending Changes/i);
    await dialog.getByRole('button', { name: /Reject all/i }).click();
    await page.getByRole('textbox', { name: /Reason/i }).fill(rejectReason);
    await screenshot(page, 'reject-all-reason');

    const rejectResponse = await waitForBeneficiaryRequest(
      page,
      'destination/reject-pending-bulk-by-beneficiary',
      () => page.getByRole('button', { name: /Confirm reject/i }).click(),
    );
    await expectResponseOk(rejectResponse, 'reject pending destination');

    row = await searchBeneficiary(page, displayName);
    await expect(row).toContainText(/Approved|Rejected/i);
    await screenshot(page, 'after-reject-pending-change');
  });

  test('BEN-UI-005: destination actions menu is available from details', async () => {
    beneficiaryUuid = await ensureApprovedDestination(api, accessToken, prerequisite());
    await openBeneficiaries(page);
    const row = await searchBeneficiary(page, displayName);
    await row.getByRole('button', { name: 'View', exact: true }).click();

    const dialog = await waitForDetailsLoaded(page, displayName);
    await dialog.getByLabel('Destination actions').first().click();
    await expect(page.getByRole('menuitem', { name: /Delete/i })).toBeVisible();
    await screenshot(page, 'destination-actions-menu');
  });
});
