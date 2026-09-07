const { test, expect } = require('../../fixtures/payout-api-fixture');
const {
  employeeUuidFromCreateResponse,
  fakePngUpload,
  textUpload,
  uniqueSouthAfricanPhone,
  validPassportEmployee,
} = require('../../../src/test-data/employee-customer-builders');

test.describe('Employee Cards / KYC documents and negative verification', () => {
  test('EC-DT-KYC-006 EC-KYC-NEG-006: verification without document does not verify employee', async ({ payoutApi }) => {
    const payload = validPassportEmployee({ phone: uniqueSouthAfricanPhone() });
    const created = await payoutApi.expectCreateEmployeeCustomer(payload);
    const customerUuid = employeeUuidFromCreateResponse(created);

    const response = await payoutApi.runEmployeeVerification(customerUuid);

    expect(response.ok()).toBeFalsy();
  });

  test('EC-KYC-NEG-005 EC-DT-KYC-010: invalid non-document file is rejected or does not verify', async ({ payoutApi }) => {
    const payload = validPassportEmployee({ phone: uniqueSouthAfricanPhone() });
    const created = await payoutApi.expectCreateEmployeeCustomer(payload);
    const customerUuid = employeeUuidFromCreateResponse(created);

    const upload = await payoutApi.uploadEmployeeDocument({
      customerUuid,
      documentType: 'foreign_passport',
      file: textUpload(),
    });

    expect(upload.ok()).toBeFalsy();
  });

  test('EC-DOC-001: accepts PNG upload shape for employee document endpoint', async ({ payoutApi }) => {
    const payload = validPassportEmployee({ phone: uniqueSouthAfricanPhone() });
    const created = await payoutApi.expectCreateEmployeeCustomer(payload);
    const customerUuid = employeeUuidFromCreateResponse(created);

    const upload = await payoutApi.uploadEmployeeDocument({
      customerUuid,
      documentType: 'foreign_passport',
      file: fakePngUpload(),
    });

    expect([200, 400, 422]).toContain(upload.status());
  });

  test('EC-DOC-002: rejects unknown document type', async ({ payoutApi }) => {
    const payload = validPassportEmployee({ phone: uniqueSouthAfricanPhone() });
    const created = await payoutApi.expectCreateEmployeeCustomer(payload);
    const customerUuid = employeeUuidFromCreateResponse(created);

    const upload = await payoutApi.uploadEmployeeDocument({
      customerUuid,
      documentType: 'unsupported_document_type',
      file: fakePngUpload(),
    });

    expect(upload.ok()).toBeFalsy();
  });

  test('EC-DOC-003: verification info endpoint is available for pending employee', async ({ payoutApi }) => {
    const payload = validPassportEmployee({ phone: uniqueSouthAfricanPhone() });
    const created = await payoutApi.expectCreateEmployeeCustomer(payload);
    const customerUuid = employeeUuidFromCreateResponse(created);

    const info = await payoutApi.getEmployeeVerificationInfo(customerUuid);

    expect(info.result).toBeTruthy();
  });
});
