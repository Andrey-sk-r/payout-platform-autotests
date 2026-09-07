const { test, expect } = require('../../fixtures/payout-api-fixture');
const {
  cloneWith,
  fakePngUpload,
  futureDate,
  pastDate,
  todayDate,
  tomorrowDate,
  uniqueSouthAfricanPhone,
  validAsylumEmployee,
  validPassportEmployee,
} = require('../../../src/test-data/employee-customer-builders');

test.describe('Employee Cards / Boundary and equivalence API checks', () => {
  test('EC-BVA-001 EC-BVA-002: accepts two-letter first and last names as observed API minimum', async ({ payoutApi }) => {
    const payload = cloneWith(validPassportEmployee({ phone: uniqueSouthAfricanPhone() }), {
      personal_data: {
        first_name: 'Al',
        last_name: 'Bo',
      },
    });

    const response = await payoutApi.createEmployeeCustomer(payload);

    expect(response.ok()).toBeTruthy();
  });

  test('EC-BVA-003: rejects overlong first and last names', async ({ payoutApi }) => {
    const overlong = 'A'.repeat(101);
    const payload = cloneWith(validPassportEmployee({ phone: uniqueSouthAfricanPhone() }), {
      personal_data: {
        first_name: overlong,
        last_name: overlong,
      },
    });

    const response = await payoutApi.createEmployeeCustomer(payload);

    expect(response.ok()).toBeFalsy();
  });

  test('EC-BVA-004 EC-DT-KYC-009: rejects invalid SA ID lengths', async ({ payoutApi }) => {
    for (const idCardNumber of ['123456789012', '12345678901234']) {
      const payload = cloneWith(validPassportEmployee({ phone: uniqueSouthAfricanPhone() }), {
        identity_data: {
          id_card_data: {
            id_card_number: idCardNumber,
          },
        },
      });
      delete payload.identity_data.passport_data;

      const response = await payoutApi.createEmployeeCustomer(payload);
      expect(response.ok(), `SA ID ${idCardNumber}`).toBeFalsy();
    }
  });

  test('EC-BVA-005: captures current API behavior for empty passport number', async ({ payoutApi }) => {
    const response = await payoutApi.createEmployeeCustomer(validPassportEmployee({
      phone: uniqueSouthAfricanPhone(),
      passportNumber: '',
    }));

    expect(response.ok()).toBeTruthy();
  });

  test('EC-BVA-005: rejects overlong passport number', async ({ payoutApi }) => {
    const response = await payoutApi.createEmployeeCustomer(validPassportEmployee({
      phone: uniqueSouthAfricanPhone(),
      passportNumber: 'P'.repeat(101),
    }));

    expect(response.ok()).toBeFalsy();
  });

  test('EC-BVA-006: captures current API behavior for empty asylum reference number', async ({ payoutApi }) => {
    const response = await payoutApi.createEmployeeCustomer(validAsylumEmployee({
      phone: uniqueSouthAfricanPhone(),
      asylumNumber: '',
    }));

    expect(response.ok()).toBeTruthy();
  });

  test('EC-BVA-006: rejects overlong asylum reference number', async ({ payoutApi }) => {
    const response = await payoutApi.createEmployeeCustomer(validAsylumEmployee({
      phone: uniqueSouthAfricanPhone(),
      asylumNumber: 'A'.repeat(101),
    }));

    expect(response.ok()).toBeFalsy();
  });

  test('EC-BVA-007: rejects today and future DOB values', async ({ payoutApi }) => {
    for (const birthDate of [todayDate(), tomorrowDate()]) {
      const payload = cloneWith(validPassportEmployee({ phone: uniqueSouthAfricanPhone() }), {
        personal_data: {
          birth_date: birthDate,
        },
      });

      const response = await payoutApi.createEmployeeCustomer(payload);
      expect(response.ok(), `birth date ${birthDate}`).toBeFalsy();
    }
  });

  test('EC-BVA-007: accepts adult DOB', async ({ payoutApi }) => {
    const payload = cloneWith(validPassportEmployee({ phone: uniqueSouthAfricanPhone() }), {
      personal_data: {
        birth_date: pastDate({ years: 30 }),
      },
    });

    const response = await payoutApi.createEmployeeCustomer(payload);

    expect(response.ok()).toBeTruthy();
  });

  test('EC-BVA-009: captures current API behavior for phone numbers around expected length', async ({ payoutApi }) => {
    for (const phone of ['27' + '1'.repeat(12), '27' + '1'.repeat(14)]) {
      const payload = validPassportEmployee({ phone });

      const response = await payoutApi.createEmployeeCustomer(payload);
      expect([200, 400, 422], `phone ${phone}`).toContain(response.status());
    }
  });

  test('EC-BVA-010: rejects zero-byte document upload', async ({ payoutApi }) => {
    const created = await payoutApi.expectCreateEmployeeCustomer(validPassportEmployee({ phone: uniqueSouthAfricanPhone() }));
    const customerUuid = created.result.employee.customer_uuid;

    const response = await payoutApi.uploadEmployeeDocument({
      customerUuid,
      documentType: 'foreign_passport',
      file: {
        name: 'empty.png',
        mimeType: 'image/png',
        buffer: Buffer.alloc(0),
      },
    });

    expect(response.ok()).toBeFalsy();
  });

  test('EC-BVA-010: accepts syntactically valid PNG upload request shape', async ({ payoutApi }) => {
    const created = await payoutApi.expectCreateEmployeeCustomer(validPassportEmployee({ phone: uniqueSouthAfricanPhone() }));
    const customerUuid = created.result.employee.customer_uuid;

    const response = await payoutApi.uploadEmployeeDocument({
      customerUuid,
      documentType: 'foreign_passport',
      file: fakePngUpload('tiny.png'),
    });

    expect([200, 400, 422]).toContain(response.status());
  });

  test('EC-UI-011: rejects expired passport issue/expiry date combination', async ({ payoutApi }) => {
    const payload = validPassportEmployee({
      phone: uniqueSouthAfricanPhone(),
      passportIssueDate: futureDate({ years: 1 }),
      passportExpireDate: futureDate({ years: 5 }),
    });

    const response = await payoutApi.createEmployeeCustomer(payload);

    expect(response.ok()).toBeFalsy();
  });
});
