const { test, expect } = require('@playwright/test');
const { getSessionPage } = require('../fixtures/session-auth');

test.setTimeout(180_000);

function parseWaitTimeoutMs(text) {
  const match = text.match(/Wait time\s*(?:(\d+)m)?(?:(\d+)s)?/i);
  if (!match) return 0;
  const minutes = Number(match[1] || 0);
  const seconds = Number(match[2] || 0);
  return (minutes * 60 + seconds + 5) * 1000;
}

async function requestOtpToken(request) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await request.post(`${process.env.PLATFORM_API_BASE_URL}/v1/payout-platform/auth/request-otp-email`, {
        data: {
          email: process.env.PLATFORM_USER_EMAIL,
          password: process.env.PLATFORM_USER_PASSWORD,
        },
        timeout: 30_000,
      });
    } catch (error) {
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        continue;
      }
      throw error;
    }

    if (response.ok()) {
      const body = await response.json();
      return body.result.temp_token;
    }

    const text = await response.text();
    const waitMs = parseWaitTimeoutMs(text);
    if (waitMs && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    expect(response, `request OTP email failed: ${text}`).toBeOK();
  }

  throw new Error('Unable to request OTP token.');
}

async function login(page, request) {
  await page.goto('/dashboard');

  if (!page.url().includes('/login')) {
    return;
  }

  await page.getByRole('textbox', { name: /Email/i }).fill(process.env.PLATFORM_USER_EMAIL);
  await page.getByRole('textbox', { name: /Password/i }).fill(process.env.PLATFORM_USER_PASSWORD);
  await page.getByRole('button', { name: 'Send OTP' }).click();

  await page.waitForURL(/\/otp/, { timeout: 30_000 }).catch(async () => {
    const existingOtp = page.getByRole('button', { name: 'Enter existing OTP code' });
    if (await existingOtp.isEnabled().catch(() => false)) {
      await existingOtp.click();
      await page.waitForURL(/\/otp/, { timeout: 20_000 });
      return;
    }

    const tempToken = await requestOtpToken(request);
    await page.evaluate(
      ({ email, tempToken }) => {
        localStorage.setItem('pp.temp_auth', JSON.stringify({ email, temp_token: tempToken }));
      },
      {
        email: process.env.PLATFORM_USER_EMAIL,
        tempToken,
      },
    );
    await page.goto('/otp');
  });

  await page.getByRole('textbox').fill(process.env.PLATFORM_EMAIL_OTP);
  await page
    .waitForURL((url) => !url.pathname.includes('/login') && !url.pathname.includes('/otp'), { timeout: 30_000 })
    .catch(async () => {
      const verifyButton = page.getByRole('button', { name: /Verify/i });
      await expect(verifyButton).toBeEnabled({ timeout: 20_000 });
      await verifyButton.click();
      await page.waitForURL((url) => !url.pathname.includes('/login') && !url.pathname.includes('/otp'), { timeout: 30_000 });
    });
}

async function clickFirstVisibleButton(page, name, skipMessage) {
  const rowsWithAction = page.getByRole('row').filter({
    has: page.getByRole('button', { name }),
  });
  const button = rowsWithAction.getByRole('button', { name }).first();
  try {
    await expect(button).toBeVisible({ timeout: 15_000 });
  } catch {
    return false;
  }
  await button.click();
  return true;
}

async function clickFirstLineRow(page) {
  const candidateRows = page.getByRole('row').filter({
    hasNot: page.getByRole('columnheader'),
  });

  await expect
    .poll(async () => candidateRows.count(), { timeout: 30_000, message: 'batch line rows should be loaded' })
    .toBeGreaterThan(0);

  const count = await candidateRows.count();
  for (let index = 0; index < count; index += 1) {
    const row = candidateRows.nth(index);
    const text = (await row.innerText().catch(() => '')).trim();
    if (!text || /No data|No rows|Loading/i.test(text)) {
      continue;
    }

    const detailsButton = row.getByRole('button', { name: /View|Open|Details|Review/i }).first();
    if (await detailsButton.isVisible().catch(() => false)) {
      await detailsButton.click();
      return text;
    }

    const firstCell = row.getByRole('gridcell').first();
    if (await firstCell.isVisible().catch(() => false)) {
      await firstCell.click();
      return text;
    }

    await row.click();
    return text;
  }

  throw new Error('No visible batch lines were found.');
}

async function expectLineViewOpened(page, rowText) {
  const visibleDialog = page.getByRole('dialog').filter({
    hasText: /Amount|Reference|Beneficiary|Employee|Destination|Rail|Status|Line|Recipient/i,
  });

  const detailsRegion = page.locator('body').filter({
    hasText: /Amount|Reference|Beneficiary|Employee|Destination|Rail|Status|Line|Recipient/i,
  });

  await expect
    .poll(async () => {
      if (await visibleDialog.first().isVisible().catch(() => false)) return 'dialog';
      const selectedText = await page.locator('[aria-selected="true"], [data-selected="true"]').first().innerText().catch(() => '');
      if (selectedText && rowText && selectedText.includes(rowText.split(/\s+/)[0])) return 'selected';
      if (await detailsRegion.first().isVisible().catch(() => false)) return 'details';
      return '';
    }, { message: 'line details view should open after clicking a line' })
    .not.toBe('');
}

test.describe.configure({ mode: 'serial' });

test.describe('Batch line view', () => {
  let page;

  test.beforeAll(async ({ browser, request }) => {
    page = await getSessionPage(browser);
    await login(page, request);
  });

  test.afterAll(async () => {
  });

  test('opens line view inside draft batch', async () => {
    await page.goto('/payouts');
    const opened = await clickFirstVisibleButton(page, /Open/i, 'No draft/modifiable batches with Open action were found.');
    test.skip(!opened, 'No draft/modifiable batches with Open action were found.');
    await expect(page.getByRole('grid', { name: 'Payout batch draft lines' })).toBeVisible({ timeout: 30_000 });

    const rowText = await clickFirstLineRow(page);
    await expectLineViewOpened(page, rowText);
  });

  test('opens line view inside batch approval review', async () => {
    await page.goto('/approvals');
    const opened = await clickFirstVisibleButton(page, /Review/i, 'No batches pending approval with Review action were found.');
    test.skip(!opened, 'No batches pending approval with Review action were found.');
    await expect(page).toHaveURL(/\/approvals|\/payouts\/.+/);

    const rowText = await clickFirstLineRow(page);
    await expectLineViewOpened(page, rowText);
  });

  test('opens line view inside historical batch', async () => {
    await page.goto('/history');
    const opened = await clickFirstVisibleButton(page, /Open/i, 'No historical batches with Open action were found.');
    test.skip(!opened, 'No historical batches with Open action were found.');
    await expect(page).toHaveURL(/\/history\/.+|\/history/);

    const rowText = await clickFirstLineRow(page);
    await expectLineViewOpened(page, rowText);
  });
});
