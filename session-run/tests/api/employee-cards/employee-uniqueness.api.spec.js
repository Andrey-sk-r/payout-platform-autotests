const { test, expect } = require('../../fixtures/payout-api-fixture');
const {
  uniqueSouthAfricanPhone,
  validPassportEmployee,
} = require('../../../src/test-data/employee-customer-builders');

test.describe('Employee Cards / Uniqueness API checks', () => {
  test('EC-DT-UNIQ-003: duplicate passport number behavior is captured', async ({ payoutApi }) => {
    const phoneA = uniqueSouthAfricanPhone();
    const phoneB = uniqueSouthAfricanPhone();
    const passportNumber = `PDUP${Date.now().toString().slice(-7)}`;

    const first = await payoutApi.createEmployeeCustomer(validPassportEmployee({
      phone: phoneA,
      passportNumber,
    }));
    expect(first.ok()).toBeTruthy();

    const second = await payoutApi.createEmployeeCustomer(validPassportEmployee({
      phone: phoneB,
      passportNumber,
    }));

    expect([200, 400, 409, 422]).toContain(second.status());
  });

  test('EC-DT-UNIQ-004: duplicate phone is rejected', async ({ payoutApi }) => {
    const phone = uniqueSouthAfricanPhone();

    const first = await payoutApi.createEmployeeCustomer(validPassportEmployee({ phone }));
    expect(first.ok()).toBeTruthy();

    const second = await payoutApi.createEmployeeCustomer(validPassportEmployee({ phone }));

    expect(second.ok()).toBeFalsy();
  });
});
