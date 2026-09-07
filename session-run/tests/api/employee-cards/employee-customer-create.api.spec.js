const { test, expect } = require('../../fixtures/payout-api-fixture');
const {
  cloneWith,
  employeeFromResponse,
  employeeUuidFromCreateResponse,
  uniqueSouthAfricanPhone,
  validAsylumEmployee,
  validPassportEmployee,
} = require('../../../src/test-data/employee-customer-builders');

test.describe('Employee Cards / Create and validation', () => {
  test('EC-UI-003 EC-DT-EDIT-001: creates draft employee with valid passport data and phone', async ({ payoutApi }) => {
    const payload = validPassportEmployee({ phone: uniqueSouthAfricanPhone() });

    const body = await payoutApi.expectCreateEmployeeCustomer(payload);
    const employee = employeeFromResponse(body);

    expect(employeeUuidFromCreateResponse(body)).toBeTruthy();
    expect(JSON.stringify(employee).toLowerCase()).toContain('not');
  });

  test('EC-DT-EDIT-002 EC-BVA-009: creates draft employee without phone and marks generated fake phone', async ({ payoutApi }) => {
    const payload = validPassportEmployee();
    delete payload.phone;

    const body = await payoutApi.expectCreateEmployeeCustomer(payload);
    const employee = employeeFromResponse(body);

    expect(employeeUuidFromCreateResponse(body)).toBeTruthy();
    expect(employee?.is_fake_phone).toBeTruthy();
    expect(String(employee?.phone || '')).toMatch(/^27\d{13}$/);
  });

  test('EC-DT-KYC-007: creates asylum-paper employee using reference number as document number', async ({ payoutApi }) => {
    const payload = validAsylumEmployee({ phone: uniqueSouthAfricanPhone() });

    const body = await payoutApi.expectCreateEmployeeCustomer(payload);

    expect(employeeUuidFromCreateResponse(body)).toBeTruthy();
  });

  test('EC-DT-EDIT-003 EC-UI-005: rejects missing required personal data', async ({ payoutApi }) => {
    const payload = validPassportEmployee({ phone: uniqueSouthAfricanPhone() });
    delete payload.personal_data;

    const response = await payoutApi.createEmployeeCustomer(payload);

    expect(response.ok()).toBeFalsy();
  });

  test('EC-DT-EDIT-003: rejects missing identity data', async ({ payoutApi }) => {
    const payload = validPassportEmployee({ phone: uniqueSouthAfricanPhone() });
    delete payload.identity_data;

    const response = await payoutApi.createEmployeeCustomer(payload);

    expect(response.ok()).toBeFalsy();
  });

  test('EC-BVA-001 EC-BVA-002: rejects empty first and last names', async ({ payoutApi }) => {
    const payload = cloneWith(validPassportEmployee({ phone: uniqueSouthAfricanPhone() }), {
      personal_data: {
        first_name: '',
        last_name: '',
      },
    });

    const response = await payoutApi.createEmployeeCustomer(payload);

    expect(response.ok()).toBeFalsy();
  });

  test('EC-UI-007: rejects one-letter first and last names according to current API min length', async ({ payoutApi }) => {
    const payload = cloneWith(validPassportEmployee({ phone: uniqueSouthAfricanPhone() }), {
      personal_data: {
        first_name: 'A',
        last_name: 'B',
      },
    });

    const response = await payoutApi.createEmployeeCustomer(payload);

    expect(response.ok()).toBeFalsy();
  });

  test('EC-UI-008: rejects special characters in name fields', async ({ payoutApi }) => {
    const payload = cloneWith(validPassportEmployee({ phone: uniqueSouthAfricanPhone() }), {
      personal_data: {
        first_name: 'QA_Codex_123',
        last_name: 'Name!@#',
      },
    });

    const response = await payoutApi.createEmployeeCustomer(payload);

    expect(response.ok()).toBeFalsy();
  });

  test('EC-BVA-011: rejects malformed passport expiry in the past', async ({ payoutApi }) => {
    const payload = validPassportEmployee({
      phone: uniqueSouthAfricanPhone(),
      passportExpireDate: '2020-01-01',
    });

    const response = await payoutApi.createEmployeeCustomer(payload);

    expect(response.ok()).toBeFalsy();
  });

  test('EC-UI-012: rejects malformed phone number', async ({ payoutApi }) => {
    const payload = validPassportEmployee({ phone: '27abc-short' });

    const response = await payoutApi.createEmployeeCustomer(payload);

    expect(response.ok()).toBeFalsy();
  });
});
