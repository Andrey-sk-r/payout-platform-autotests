const { test, expect } = require('../../fixtures/payout-api-fixture');
const { chromium } = require('@playwright/test');
const { optionalEnv } = require('../../../src/config/env');
const fs = require('fs');
const path = require('path');
const {
  cardUuidFromEmployee,
  employeeFromResponse,
  employeeUuidFromCreateResponse,
  uniqueActivationToken,
  uniqueSouthAfricanPhone,
  uniqueTrackingId,
  validPassportEmployee,
} = require('../../../src/test-data/employee-customer-builders');

const platformEnv = process.env.PLATFORM_ENV || 'dev';
const isDev = platformEnv === 'dev';
const passportFixtureDir = optionalEnv(
  'EMPLOYEE_CARD_PASSPORT_FIXTURE_DIR',
  path.join(process.cwd(), 'test-results', 'generated-card-passports'),
);
const verifiedNoCardUuid = optionalEnv('EMPLOYEE_VERIFIED_NO_CARD_UUID');
const allocatedCardCustomerUuid = optionalEnv('EMPLOYEE_ALLOCATED_CARD_CUSTOMER_UUID');
const activeCardCustomerUuid = optionalEnv('EMPLOYEE_ACTIVE_CARD_CUSTOMER_UUID');
const allowMutatingCardTests = optionalEnv('ALLOW_MUTATING_CARD_TESTS') === 'true';
const verifiedNoCardUuidA = optionalEnv('EMPLOYEE_VERIFIED_NO_CARD_UUID_A');
const verifiedNoCardUuidB = optionalEnv('EMPLOYEE_VERIFIED_NO_CARD_UUID_B');
const allocatedCardCustomerUuidA = optionalEnv('EMPLOYEE_ALLOCATED_CARD_CUSTOMER_UUID_A');
const allocatedCardCustomerUuidB = optionalEnv('EMPLOYEE_ALLOCATED_CARD_CUSTOMER_UUID_B');

function testIf(condition) {
  return condition ? test : test.skip;
}

async function clickVisibleText(page, text) {
  const elements = page.getByText(text, { exact: true });
  const count = await elements.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const element = elements.nth(index);
    if (await element.isVisible().catch(() => false)) {
      await element.click({ timeout: 10_000 });
      return;
    }
  }
  throw new Error(`Visible text not found: ${text}`);
}

async function clickVisibleButtonContaining(page, text, { last = false } = {}) {
  const buttons = page.locator('button').filter({ hasText: text });
  const count = await buttons.count().catch(() => 0);
  const indexes = Array.from({ length: count }, (_, index) => index);
  if (last) {
    indexes.reverse();
  }

  for (const index of indexes) {
    const button = buttons.nth(index);
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 10_000 });
      return;
    }
  }
  throw new Error(`Visible button not found: ${text}`);
}

async function passportFixture(employeeName) {
  const fixtureDir = path.join(path.resolve(passportFixtureDir), `${Date.now()}-${Math.floor(Math.random() * 1000)}`);
  const downloadsDir = path.join(fixtureDir, 'downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });

  const browser = await chromium.launch({ headless: process.env.PLAYWRIGHT_HEADED !== 'true' });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();

  try {
    await page.goto('https://playdayteam.github.io/generator_documents/#asylum', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await clickVisibleText(page, 'Passport');
    await clickVisibleButtonContaining(page, 'Fast Registration');
    await page.waitForTimeout(1_000);
    await page.locator('#pp_names').fill(employeeName.firstName.toUpperCase());
    await page.locator('#pp_surname').fill(employeeName.lastName.toUpperCase());
    await clickVisibleButtonContaining(page, 'Generate Passport');
    await page.waitForTimeout(1_500);

    const data = await page.evaluate(() => {
      const value = (selector) => document.querySelector(selector)?.value || '';
      return {
        passportNumber: value('#pp_number'),
        identityNumber: value('#pp_identity_no'),
        surname: value('#pp_surname'),
        names: value('#pp_names'),
        nationality: value('#pp_nationality'),
        dob: value('#pp_dob'),
        sex: value('#pp_sex'),
        issue: value('#pp_issue'),
        expiry: value('#pp_expiry'),
        authority: value('#pp_authority'),
        countryCode: value('#pp_country_code'),
      };
    });
    fs.writeFileSync(path.join(fixtureDir, 'passport-data.json'), JSON.stringify(data, null, 2), 'utf8');

    const downloadPromise = page.waitForEvent('download', { timeout: 20_000 });
    await clickVisibleButtonContaining(page, 'Passport', { last: true });
    const download = await downloadPromise;
    const documentPath = path.join(downloadsDir, download.suggestedFilename());
    await download.saveAs(documentPath);

    return {
      data,
      file: {
        name: path.basename(documentPath),
        mimeType: 'image/png',
        buffer: fs.readFileSync(documentPath),
      },
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function employeeCardUuid(payoutApi, customerUuid) {
  const body = await payoutApi.getEmployeeCustomerByUuid(customerUuid);
  const cardUuid = cardUuidFromEmployee(employeeFromResponse(body));
  expect(cardUuid, `card_uuid for ${customerUuid}`).toBeTruthy();
  return cardUuid;
}

async function getEmployee(payoutApi, customerUuid) {
  const body = await payoutApi.getEmployeeCustomerByUuid(customerUuid);
  return employeeFromResponse(body);
}

async function waitForEmployee(payoutApi, customerUuid, predicate, description) {
  const deadline = Date.now() + 60_000;
  let employee;

  while (Date.now() < deadline) {
    employee = await getEmployee(payoutApi, customerUuid);
    if (predicate(employee)) {
      return employee;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  expect(predicate(employee), description).toBeTruthy();
  return employee;
}

async function waitForEmployeeOrNull(payoutApi, customerUuid, predicate) {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const employee = await getEmployee(payoutApi, customerUuid);
    if (predicate(employee)) {
      return employee;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  return null;
}

async function activateEmployeeCardWhenReady(payoutApi, { customerUuid, cardUuid, token }) {
  const deadline = Date.now() + 45_000;
  let lastResponse;
  let lastBody = {};

  while (Date.now() < deadline) {
    lastResponse = await payoutApi.activateEmployeeCard({ customerUuid, cardUuid, token });
    lastBody = await lastResponse.json().catch(() => ({}));
    if (lastResponse.ok()) {
      return lastResponse;
    }

    if (lastBody?.error?.code !== 'activate_card' || !String(lastBody?.error?.detail || '').includes('card_not_found')) {
      expect(lastResponse, `activate card: ${JSON.stringify(lastBody)}`).toBeOK();
    }

    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  expect(lastResponse, `activate card after retry: ${JSON.stringify(lastBody)}`).toBeOK();
  return lastResponse;
}

async function createVerifiedEmployeeFromPassportFixture(payoutApi) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const employeeName = { firstName: 'Thulisile', lastName: 'Vuma' };
    const fixture = await passportFixture(employeeName);
    const payload = validPassportEmployee({
      firstName: employeeName.firstName,
      lastName: employeeName.lastName,
      payrollId: `CARD-LIFECYCLE-${Date.now()}`,
      birthDate: fixture.data.dob,
      passportNumber: fixture.data.passportNumber,
      passportCountry: fixture.data.countryCode,
      passportIssueDate: fixture.data.issue,
      passportExpireDate: fixture.data.expiry,
      phone: uniqueSouthAfricanPhone(),
    });

    const create = await payoutApi.createEmployeeCustomer(payload);
    const createdBody = await create.json().catch(() => ({}));
    let customerUuid;
    if (create.ok()) {
      customerUuid = employeeUuidFromCreateResponse(createdBody);
    } else if (createdBody?.error?.code !== 'profile_already_exists') {
      expect(create, `create employee customer: ${JSON.stringify(createdBody)}`).toBeOK();
    }

    if (!customerUuid) {
      continue;
    }

    const upload = await payoutApi.uploadEmployeeDocument({
      customerUuid,
      documentType: 'foreign_passport',
      file: fixture.file,
    });
    await expect(upload, 'upload generated passport document').toBeOK();

    const verification = await payoutApi.runEmployeeVerification(customerUuid);
    await expect(verification, 'run generated passport verification').toBeOK();

    const verified = await waitForEmployeeOrNull(
      payoutApi,
      customerUuid,
      (employee) => employee?.kyc_status === 'verified' || employee?.profile_verification?.verification_status === 'verified',
    );

    if (verified) {
      return customerUuid;
    }
  }

  expect(false, 'generated passport employee becomes verified within 3 attempts').toBeTruthy();
  return null;
}

test.describe('Employee Cards / Card lifecycle API', () => {
  testIf(isDev)('EC-CARD-DEV-001: creates verified employee and allocates/activates card with random dev tokens', async ({ payoutApi }) => {
    test.setTimeout(120_000);

    const customerUuid = await createVerifiedEmployeeFromPassportFixture(payoutApi);
    const trackingId = uniqueTrackingId();

    const allocate = await payoutApi.allocateEmployeeCard({
      customerUuid,
      token: trackingId,
    });
    await expect(allocate, `allocate card with random tracking ${trackingId}`).toBeOK();

    const allocatedEmployee = await waitForEmployee(
      payoutApi,
      customerUuid,
      (employee) => Boolean(cardUuidFromEmployee(employee)),
      `employee ${customerUuid} has allocated card`,
    );
    const cardUuid = cardUuidFromEmployee(allocatedEmployee);
    const activationToken = uniqueActivationToken();

    await activateEmployeeCardWhenReady(payoutApi, {
      customerUuid,
      cardUuid,
      token: activationToken,
    });

    await waitForEmployee(
      payoutApi,
      customerUuid,
      (employee) => JSON.stringify(employee).toLowerCase().includes('active'),
      `employee ${customerUuid} card becomes active`,
    );
  });

  testIf(verifiedNoCardUuid)('EC-CARD-ALLOC-001 EC-DT-CARD-003: allocates card for prepared verified employee without card', async ({ payoutApi }) => {
    const response = await payoutApi.allocateEmployeeCard({
      customerUuid: verifiedNoCardUuid,
      token: uniqueTrackingId(),
    });

    expect(response.ok()).toBeTruthy();
    expect(JSON.stringify(await response.json()).toLowerCase()).toContain('allocated');
  });

  testIf(verifiedNoCardUuid)('EC-CARD-ALLOC-002: rejects empty tracking ID', async ({ payoutApi }) => {
    const response = await payoutApi.allocateEmployeeCard({
      customerUuid: verifiedNoCardUuid,
      token: '',
    });

    expect(response.ok()).toBeFalsy();
  });

  testIf(allocatedCardCustomerUuid)('EC-CARD-ACT-001 EC-DT-CARD-004: activates prepared allocated card', async ({ payoutApi }) => {
    const cardUuid = await employeeCardUuid(payoutApi, allocatedCardCustomerUuid);

    const response = await payoutApi.activateEmployeeCard({
      customerUuid: allocatedCardCustomerUuid,
      cardUuid,
      token: uniqueActivationToken(),
    });

    expect(response.ok()).toBeTruthy();
    expect(JSON.stringify(await response.json()).toLowerCase()).toContain('active');
  });

  testIf(allocatedCardCustomerUuid)('EC-CARD-ACT-002: rejects empty activation token', async ({ payoutApi }) => {
    const cardUuid = await employeeCardUuid(payoutApi, allocatedCardCustomerUuid);

    const response = await payoutApi.activateEmployeeCard({
      customerUuid: allocatedCardCustomerUuid,
      cardUuid,
      token: '',
    });

    expect(response.ok()).toBeFalsy();
  });

  testIf(allowMutatingCardTests && activeCardCustomerUuid)('EC-CARD-BLOCK-001 EC-DT-CARD-006: blocks prepared active card with supported block status', async ({ payoutApi }) => {
    const blockStatus = optionalEnv('EMPLOYEE_CARD_BLOCK_STATUS', 'stop');
    const cardUuid = await employeeCardUuid(payoutApi, activeCardCustomerUuid);

    const response = await payoutApi.blockEmployeeCard({
      customerUuid: activeCardCustomerUuid,
      cardUuid,
      status: blockStatus,
    });

    expect(response.ok()).toBeTruthy();
  });

  testIf(activeCardCustomerUuid)('EC-CARD-BLOCK-002: rejects empty block status', async ({ payoutApi }) => {
    const cardUuid = await employeeCardUuid(payoutApi, activeCardCustomerUuid);

    const response = await payoutApi.blockEmployeeCard({
      customerUuid: activeCardCustomerUuid,
      cardUuid,
      status: '',
    });

    expect(response.ok()).toBeFalsy();
  });

  testIf(!isDev && allowMutatingCardTests && verifiedNoCardUuidA && verifiedNoCardUuidB)('EC-DT-UNIQ-001 EC-CARD-ALLOC-003: duplicate tracking ID is rejected for second employee', async ({ payoutApi }) => {
    const duplicateTrackingId = uniqueTrackingId();

    const first = await payoutApi.allocateEmployeeCard({ customerUuid: verifiedNoCardUuidA, token: duplicateTrackingId });
    expect(first.ok()).toBeTruthy();

    const second = await payoutApi.allocateEmployeeCard({ customerUuid: verifiedNoCardUuidB, token: duplicateTrackingId });
    expect(second.ok()).toBeFalsy();
  });

  testIf(!isDev && allowMutatingCardTests && allocatedCardCustomerUuidA && allocatedCardCustomerUuidB)('EC-DT-UNIQ-002 EC-CARD-ACT-003: duplicate activation token is rejected for second card', async ({ payoutApi }) => {
    const duplicateActivationToken = uniqueActivationToken();

    const cardA = await employeeCardUuid(payoutApi, allocatedCardCustomerUuidA);
    const cardB = await employeeCardUuid(payoutApi, allocatedCardCustomerUuidB);

    const first = await payoutApi.activateEmployeeCard({
      customerUuid: allocatedCardCustomerUuidA,
      cardUuid: cardA,
      token: duplicateActivationToken,
    });
    expect(first.ok()).toBeTruthy();

    const second = await payoutApi.activateEmployeeCard({
      customerUuid: allocatedCardCustomerUuidB,
      cardUuid: cardB,
      token: duplicateActivationToken,
    });
    expect(second.ok()).toBeFalsy();
  });
});
