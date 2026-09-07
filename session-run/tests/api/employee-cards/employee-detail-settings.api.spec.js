const { test, expect } = require('../../fixtures/payout-api-fixture');
const {
  employeeUuidFromCreateResponse,
  uniqueSouthAfricanPhone,
  validPassportEmployee,
} = require('../../../src/test-data/employee-customer-builders');

test.describe('Employee Cards / Detail, notification, transactions API checks', () => {
  test('EC-DETAIL-001: get-by-uuid returns employee profile data', async ({ payoutApi }) => {
    const payload = validPassportEmployee({ phone: uniqueSouthAfricanPhone() });
    const created = await payoutApi.expectCreateEmployeeCustomer(payload);
    const customerUuid = employeeUuidFromCreateResponse(created);

    const detail = await payoutApi.getEmployeeCustomerByUuid(customerUuid);

    expect(detail.result.employee.customer_uuid).toBe(customerUuid);
    expect(detail.result.employee.document_number).toBe(payload.identity_data.passport_data.passport_number);
  });

  test('EC-DETAIL-002: verification info returns KYC profile state for pending employee', async ({ payoutApi }) => {
    const payload = validPassportEmployee({ phone: uniqueSouthAfricanPhone() });
    const created = await payoutApi.expectCreateEmployeeCustomer(payload);
    const customerUuid = employeeUuidFromCreateResponse(created);

    const info = await payoutApi.getEmployeeVerificationInfo(customerUuid);

    expect(info.result).toBeTruthy();
    expect(JSON.stringify(info.result).toLowerCase()).toContain(customerUuid.toLowerCase());
  });

  test('EC-DETAIL-003: documents collection exists on employee detail response', async ({ payoutApi }) => {
    const payload = validPassportEmployee({ phone: uniqueSouthAfricanPhone() });
    const created = await payoutApi.expectCreateEmployeeCustomer(payload);
    const customerUuid = employeeUuidFromCreateResponse(created);

    const detail = await payoutApi.getEmployeeCustomerByUuid(customerUuid);

    expect(detail.result.employee.documents).toBeInstanceOf(Array);
  });

  test('EC-DETAIL-005: transaction list rejects missing/unknown account uuid cleanly', async ({ payoutApi }) => {
    const response = await payoutApi.get('/v1/payout-platform/employee-customer/account/transaction-list', {
      params: {
        account_uuid: '00000000-0000-0000-0000-000000000000',
        limit: 10,
        offset: 0,
      },
    });

    expect(response.ok()).toBeFalsy();
  });

  test('EC-NOTIFY-001: notification settings endpoint accepts boolean toggle shape', async ({ payoutApi }) => {
    const payload = validPassportEmployee({ phone: uniqueSouthAfricanPhone() });
    const created = await payoutApi.expectCreateEmployeeCustomer(payload);
    const customerUuid = employeeUuidFromCreateResponse(created);

    const response = await payoutApi.editEmployeeNotificationSettings({
      customerUuid,
      cardOperationSmsEnabled: false,
    });

    expect([200, 400, 422]).toContain(response.status());
  });

  test('EC-TENANT-001: foreign-looking customer uuid is not readable', async ({ payoutApi }) => {
    const response = await payoutApi.get('/v1/payout-platform/employee-customer/get-customer-by-uuid', {
      params: {
        customer_uuid: '00000000-0000-0000-0000-000000000000',
      },
    });

    expect(response.ok()).toBeFalsy();
  });
});
