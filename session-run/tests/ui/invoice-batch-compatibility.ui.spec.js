const { test, expect } = require('@playwright/test');
const { invoiceFixture, uniqueUpload } = require('../fixtures/invoice-test-assets');
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

async function waitForTerminalParse(row) {
  await expect(row.getByText(/parsing…|Processing|Pending/i)).toHaveCount(0, { timeout: 90_000 });
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function uploadInvoice(page, fixturePath, prefix, testInfo, { waitForTerminal = true } = {}) {
  const upload = uniqueUpload(fixturePath, prefix, testInfo);
  await page.goto('/invoice-inbox?page=1&limit=25');
  await page.getByRole('button', { name: 'Upload invoice' }).click();
  await page.locator('input[type="file"]').setInputFiles(upload);
  await page.getByRole('button', { name: 'Upload', exact: true }).click();

  const row = page.getByRole('row', { name: new RegExp(escaped(upload.name)) });
  await expect(row).toBeVisible({ timeout: 45_000 });
  if (waitForTerminal) await waitForTerminalParse(row);
  return { row, fileName: upload.name };
}

async function selectInvoice(row) {
  const selection = row.getByRole('checkbox');
  await expect(selection).toBeEnabled();
  await selection.check({ force: true });
}

async function createDraftFromSelection(page, expectedFileNames) {
  await page.getByRole('button', { name: new RegExp(`Create batch \\(${expectedFileNames.length}\\)`) }).click();
  const dialog = page.getByRole('dialog', { name: 'Create batch from invoices' });
  await expect(dialog).toBeVisible();
  for (const fileName of expectedFileNames) {
    await expect(dialog.getByText(fileName, { exact: true })).toBeVisible();
  }
  await dialog.getByRole('button', { name: /^Create batch$/i }).click();
  await page.waitForURL(/\/payouts\/[^/]+\/draft/, { timeout: 45_000 });
  return page.url().match(/\/payouts\/([^/]+)\/draft/)?.[1] || null;
}

async function createDraftFromFixture(page, fixturePath, prefix, testInfo) {
  const uploaded = await uploadInvoice(page, fixturePath, prefix, testInfo);
  await expect(uploaded.row.getByText('new', { exact: true })).toBeVisible();
  await selectInvoice(uploaded.row);
  const batchUuid = await createDraftFromSelection(page, [uploaded.fileName]);
  expect(batchUuid, 'created draft batch uuid').toBeTruthy();
  await expect(page.getByText(uploaded.fileName, { exact: true })).toBeVisible({ timeout: 45_000 });
  return { ...uploaded, batchUuid };
}

async function openOnlyLineEditor(page) {
  const edit = page.getByRole('button', { name: 'Edit recipient' });
  await expect(edit).toHaveCount(1, { timeout: 45_000 });
  await edit.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Invoice');
  return dialog;
}

async function detachAndAttach(page, fileName) {
  const dialog = await openOnlyLineEditor(page);
  await dialog.getByRole('button', { name: 'Detach invoice' }).click();
  await expect(dialog).toContainText('No invoice attached');
  await dialog.getByRole('button', { name: 'Attach invoice' }).click();
  const picker = page.getByRole('dialog', { name: 'Select invoice' });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: `Select ${fileName}` }).click();
  await expect(picker).toBeHidden({ timeout: 30_000 });
  await expect(dialog).toContainText(fileName);
  return dialog;
}

function summaryCard(page) {
  return page.getByText('Batch Summary', { exact: true }).locator('..').locator('..');
}

async function metricValue(container, label) {
  const content = await container.innerText();
  const match = content.match(new RegExp(`${label}\\s+([^\\n]+)`, 'i'));
  expect(match, `${label} is present in the batch summary`).toBeTruthy();
  return match[1].trim();
}

function invoiceEditor(page) {
  return page.getByRole('dialog', { name: 'Edit invoice data' });
}

function recipientEditor(page) {
  return page.getByRole('dialog').filter({ hasText: 'Internal reference' });
}

test.describe('Invoice and draft-batch compatibility', () => {
  test.beforeEach(() => {
    if (process.env.PLATFORM_ENV !== 'stage') {
      throw new Error('INV-BATCH scenarios require PLATFORM_ENV=stage because they create draft batches.');
    }
    if (process.env.ALLOW_MUTATING_INVOICE_BATCH_TESTS !== 'true') {
      throw new Error('Set ALLOW_MUTATING_INVOICE_BATCH_TESTS=true to run INV-BATCH scenarios.');
    }
  });

  test('INV-BATCH-001: non-zero ZAR invoice becomes eligible and can target a draft', async ({ browser, request }, testInfo) => {
    const page = await getSessionPage(browser);
    await login(page, request);
    const { row, fileName } = await uploadInvoice(page, invoiceFixture('validZar'), 'INV-BATCH-ELIGIBLE', testInfo);
    await expect(row.getByText('new', { exact: true })).toBeVisible();
    await expect(row).toContainText(/R\s*[1-9]/);

    await selectInvoice(row);
    await expect(page.getByRole('button', { name: 'Create batch (1)' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Add to existing draft batch' })).toBeEnabled();

    await page.getByRole('button', { name: 'Add to existing draft batch' }).click();
    await expect(page.getByRole('heading', { name: 'Add to draft batch' })).toBeVisible();
    await expect(page.getByRole('option').first()).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.getByRole('button', { name: 'Create batch (1)' }).click();
    const createDialog = page.getByRole('dialog', { name: 'Create batch from invoices' });
    await expect(createDialog).toBeVisible();
    await expect(createDialog.getByText(fileName, { exact: true })).toBeVisible();
    await createDialog.getByRole('button', { name: 'Create batch', exact: true }).click();
    await page.waitForURL(/\/payouts\/[^/]+\/draft/, { timeout: 45_000 });
    await expect(page.getByRole('button').filter({ hasText: fileName })).toBeVisible();
    await expect(page.getByRole('button', { name: /Send for Approval/i })).toBeVisible();
  });

  test('INV-BATCH-002: parsing invoice remains batch-selectable by requirement', async ({ browser, request }, testInfo) => {
    const page = await getSessionPage(browser);
    await login(page, request);
    const uploaded = await uploadInvoice(
      page,
      invoiceFixture('validZar'),
      'INV-BATCH-PROCESSING',
      testInfo,
      { waitForTerminal: false },
    );

    await expect(uploaded.row.getByText('parsing…', { exact: true })).toBeVisible({ timeout: 45_000 });
    await selectInvoice(uploaded.row);
    await expect(page.getByRole('button', { name: 'Create batch (1)' })).toBeEnabled();
    await createDraftFromSelection(page, [uploaded.fileName]);
    await expect(page.getByRole('button', { name: /Send for Approval/i })).toBeDisabled();
  });

  test('INV-BATCH-003: duplicate invoice warning remains advisory', async ({ browser, request }, testInfo) => {
    const page = await getSessionPage(browser);
    await login(page, request);
    const fixture = invoiceFixture('validZar');
    const first = await uploadInvoice(page, fixture, 'INV-BATCH-DUPLICATE', testInfo);
    const second = await uploadInvoice(page, fixture, 'INV-BATCH-DUPLICATE', testInfo);

    await expect(first.row.getByText('new', { exact: true })).toBeVisible();
    await expect(second.row.getByText('new', { exact: true })).toBeVisible();
    await expect(second.row.getByLabel('Possible duplicate of an earlier invoice')).toBeVisible();

    await selectInvoice(first.row);
    await selectInvoice(second.row);
    await expect(page.getByRole('button', { name: 'Create batch (2)' })).toBeEnabled();
    await createDraftFromSelection(page, [first.fileName, second.fileName]);
  });

  test('INV-BATCH-004: draft detail grand total must equal the list total', async ({ browser, request }, testInfo) => {
    const page = await getSessionPage(browser);
    await login(page, request);
    const { fileName } = await createDraftFromFixture(page, invoiceFixture('validZar'), 'INV-BATCH-TOTALS', testInfo);
    await detachAndAttach(page, fileName);
    await page.reload();

    const summary = summaryCard(page);
    await expect(summary).toContainText(/Total amount\s+R\s*[1-9]/i);
    await expect(summary).toContainText(/Total fee\s+R\s*[1-9]/i);
    await expect(summary).toContainText(/Grand total\s+R\s*[1-9]/i);
    const grandTotal = await metricValue(summary, 'Grand total');

    const batchUuid = page.url().match(/\/payouts\/([^/]+)\/draft/)?.[1];
    expect(batchUuid).toBeTruthy();
    await page.goto('/payouts');
    const batchRow = page.locator(`tr[id="${batchUuid}"]`);
    await expect(batchRow).toBeVisible({ timeout: 45_000 });
    await expect(batchRow).toContainText(grandTotal);
  });

  test('INV-BATCH-005: an invoice already in another active batch cannot be attached', async ({ browser, request }, testInfo) => {
    const page = await getSessionPage(browser);
    await login(page, request);
    const first = await createDraftFromFixture(page, invoiceFixture('validZar'), 'INV-BATCH-EXCLUSIVE-A', testInfo);
    const second = await createDraftFromFixture(page, invoiceFixture('validZarSecond'), 'INV-BATCH-EXCLUSIVE-B', testInfo);

    const editor = await openOnlyLineEditor(page);
    await editor.getByRole('button', { name: 'Detach invoice' }).click();
    await editor.getByRole('button', { name: 'Attach invoice' }).click();
    const picker = page.getByRole('dialog', { name: 'Select invoice' });
    await picker.getByRole('button', { name: `Select ${first.fileName}` }).click();
    await expect(picker).toBeVisible();
    await expect(page.getByText('Attach failed', { exact: true })).toBeVisible();
    await expect(editor).toContainText('No invoice attached');

    await picker.getByRole('button', { name: `Select ${second.fileName}` }).click();
    await expect(picker).toBeHidden({ timeout: 30_000 });
    await expect(editor).toContainText(second.fileName);
  });

  test('INV-BATCH-006: reattaching an invoice refreshes every draft aggregate', async ({ browser, request }, testInfo) => {
    const page = await getSessionPage(browser);
    await login(page, request);
    const { fileName } = await createDraftFromFixture(page, invoiceFixture('validZar'), 'INV-BATCH-REATTACH', testInfo);
    const before = await summaryCard(page).innerText();
    await detachAndAttach(page, fileName);
    await page.reload();
    const after = await summaryCard(page).innerText();

    expect(after).toMatch(/Total amount\s+R\s*[1-9]/i);
    expect(after).toMatch(/Total fee\s+R\s*[1-9]/i);
    expect(after).toMatch(/Grand total\s+R\s*[1-9]/i);
    expect(after).toContain(before.match(/Total amount\s+R\s*[^\n]+/i)?.[0] || 'Total amount');
  });

  test('INV-BATCH-007: correcting an invoice total refreshes its draft line', async ({ browser, request }, testInfo) => {
    const page = await getSessionPage(browser);
    await login(page, request);
    const { fileName } = await createDraftFromFixture(page, invoiceFixture('validZar'), 'INV-BATCH-WRITE-THROUGH', testInfo);
    await page.getByText(fileName, { exact: true }).last().click();
    const drawer = page.getByRole('dialog', { name: 'Batch line details' });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: 'Edit' }).click();
    const invoiceDialog = invoiceEditor(page);
    await expect(invoiceDialog.getByLabel('Total (incl. VAT)')).toBeVisible();
    const unlink = invoiceDialog.getByRole('button', { name: /Unlink total|Link total to Subtotal \+ VAT/i });
    if (await unlink.getAttribute('aria-label') === 'Unlink total') await unlink.click();
    await invoiceDialog.getByLabel('Total (incl. VAT)').fill('70.88');
    await invoiceDialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(invoiceDialog).toBeHidden({ timeout: 30_000 });
    await page.reload();

    await expect(page.getByText(/R\s*70[,.]88/)).toBeVisible();
    await expect(summaryCard(page)).toContainText(/R\s*70[,.]88/);
  });

  test('INV-BATCH-008: non-ZAR invoice edit returns to recipient editing', async ({ browser, request }, testInfo) => {
    const page = await getSessionPage(browser);
    await login(page, request);
    const { fileName } = await createDraftFromFixture(page, invoiceFixture('usd'), 'INV-BATCH-USD', testInfo);
    await page.getByText(fileName, { exact: true }).last().click();
    const drawer = page.getByRole('dialog', { name: 'Batch line details' });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: 'Edit' }).click();

    const invoiceDialog = invoiceEditor(page);
    const currency = invoiceDialog.getByLabel('Currency');
    await expect(currency).toHaveValue(/USD/i);
    await currency.fill('usd');
    await invoiceDialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(invoiceDialog).toBeHidden({ timeout: 30_000 });

    await expect(page.getByRole('button', { name: 'Edit recipient' })).toBeVisible();
    await page.getByRole('button', { name: 'Edit recipient' }).click();
    const recipientDialog = recipientEditor(page);
    await expect(recipientDialog).toContainText(/USD/i);
    await expect(recipientDialog).toContainText(/ZAR currency only|only ZAR/i);

    await recipientDialog.getByRole('button', { name: 'Edit invoice' }).click();
    const zarDialog = invoiceEditor(page);
    await zarDialog.getByLabel('Currency').fill('ZAR');
    await zarDialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(zarDialog).toBeHidden({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Edit recipient' }).click();
    await expect(recipientEditor(page)).not.toContainText(/ZAR currency only|only ZAR/i);
  });

  test('INV-BATCH-009: use-existing-beneficiary resolves a bank-owner conflict', async ({ browser, request }, testInfo) => {
    const page = await getSessionPage(browser);
    await login(page, request);
    const { fileName } = await createDraftFromFixture(page, invoiceFixture('conflict'), 'INV-BATCH-CONFLICT', testInfo);
    const editDialog = await openOnlyLineEditor(page);
    const originalAmount = await editDialog.getByLabel('Amount').inputValue();
    const originalReference = await editDialog.getByLabel('Reference').inputValue();
    const beneficiary = editDialog.getByLabel('Beneficiary Name');
    await expect(beneficiary).toBeVisible({ timeout: 45_000 });
    await beneficiary.fill('CITRUS SUPPLY - QA DIVISION');
    const suggestion = page.getByRole('option', { name: /CITRUS SUPPLY - QA DIVISION/i }).first();
    await expect(suggestion).toBeVisible({ timeout: 45_000 });
    await suggestion.click();
    await editDialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(editDialog).toBeHidden({ timeout: 30_000 });
    await page.reload();

    await expect(page.getByText(fileName, { exact: true })).toBeVisible();
    await expect(summaryCard(page)).toContainText(/Total amount\s+R\s*[1-9]/i);
    await expect(summaryCard(page)).toContainText(/Grand total\s+R\s*[1-9]/i);
    const verifiedEditor = await openOnlyLineEditor(page);
    await expect(verifiedEditor.getByLabel('Amount')).toHaveValue(originalAmount);
    await expect(verifiedEditor.getByLabel('Reference')).toHaveValue(originalReference);
  });

  test('INV-BATCH-010: archiving a batch-linked invoice hides and marks it unavailable', async ({ browser, request }, testInfo) => {
    const page = await getSessionPage(browser);
    await login(page, request);
    const { fileName, batchUuid } = await createDraftFromFixture(page, invoiceFixture('validZarSecond'), 'INV-BATCH-ARCHIVE', testInfo);
    await page.goto('/invoice-inbox?page=1&limit=25');
    const row = page.getByRole('row', { name: new RegExp(escaped(fileName)) });
    await expect(row).toContainText(/Added To Batch|Draft/i);
    await row.getByRole('button', { name: `Archive ${fileName}` }).click();
    const confirm = page.getByRole('dialog', { name: 'Archive invoice?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(row).toHaveCount(0, { timeout: 30_000 });

    const archivedSwitch = page.getByRole('switch', { name: /Include archived/i });
    await archivedSwitch.check();
    const archived = page.getByRole('row', { name: new RegExp(escaped(fileName)) });
    await expect(archived).toContainText('Archived');
    await expect(archived.getByLabel('Archived — cannot be added to a batch')).toBeVisible();
    await expect(archived.locator(`a[href="/payouts/${batchUuid}/draft"]`)).toBeVisible();
  });
});
