const { test, expect } = require('../../fixtures/payout-api-fixture');
const {
  cloneWith,
  employeeFromResponse,
  employeeUuidFromCreateResponse,
  uniqueSouthAfricanPhone,
  uniquePayrollId,
  validPassportEmployee,
} = require('../../../src/test-data/employee-customer-builders');

test.describe('Employee Cards / Search, filters, edit, audit', () => {
  test('EC-SEARCH-001 EC-SEARCH-003: filters employee list by name and document number', async ({ payoutApi }) => {
    const payload = validPassportEmployee({ phone: uniqueSouthAfricanPhone() });
    const passportNumber = payload.identity_data.passport_data.passport_number;
    const fullName = `${payload.personal_data.first_name} ${payload.personal_data.last_name}`;

    const created = await payoutApi.expectCreateEmployeeCustomer(payload);
    const createdEmployee = employeeFromResponse(created);
    const customerUuid = createdEmployee.customer_uuid;

    const byName = await payoutApi.listEmployeeCustomers({ name: fullName, limit: 10, offset: 0 });
    expect(JSON.stringify(byName).toLowerCase()).toContain(payload.personal_data.last_name.toLowerCase());
    const listedEmployee = byName.result.list.find((employee) => employee.customer_uuid === customerUuid);
    expect(listedEmployee, 'created employee must be returned by name filter').toBeTruthy();

    const byDocument = await payoutApi.listEmployeeCustomers({ document_number: passportNumber, limit: 10, offset: 0 });
    expect(JSON.stringify(byDocument)).toContain(passportNumber);
  });

  test('EC-SEARCH-002: filters employee list by generated payroll ID from created employee', async ({ payoutApi }) => {
    const requestedPayrollId = uniquePayrollId('PAY-SEARCH');
    const payload = validPassportEmployee({
      payrollId: requestedPayrollId,
      phone: uniqueSouthAfricanPhone(),
    });

    const created = await payoutApi.expectCreateEmployeeCustomer(payload);
    const createdEmployee = employeeFromResponse(created);
    const generatedPayrollId = createdEmployee.payroll_id;
    expect(generatedPayrollId).toMatch(/^PAY-\d{3}-\d{5}$/);
    expect(generatedPayrollId).not.toBe(requestedPayrollId);

    const byPayroll = await payoutApi.listEmployeeCustomers({
      payroll_id: generatedPayrollId,
      limit: 10,
      offset: 0,
    });
    const listedEmployee = byPayroll.result.list.find((employee) => employee.customer_uuid === createdEmployee.customer_uuid);
    expect(listedEmployee, 'created employee must be returned by payroll_id filter').toBeTruthy();
    expect(listedEmployee.payroll_id).toBe(generatedPayrollId);
  });

  test('EC-FILTER-001 EC-FILTER-002: list accepts KYC and card status filters', async ({ payoutApi }) => {
    const byKyc = await payoutApi.listEmployeeCustomers({ kyc_status: 'not_verified', limit: 5, offset: 0 });
    expect(byKyc.result.list).toBeInstanceOf(Array);

    const byCard = await payoutApi.listEmployeeCustomers({ card_status: 'not_allocated', limit: 5, offset: 0 });
    expect(byCard.result.list).toBeInstanceOf(Array);
  });

  test('EC-PAGE-001 EC-PAGE-002: list supports limit and offset pagination', async ({ payoutApi }) => {
    const firstPage = await payoutApi.listEmployeeCustomers({ limit: 1, offset: 0 });
    const secondPage = await payoutApi.listEmployeeCustomers({ limit: 1, offset: 1 });

    expect(firstPage.result.list.length).toBeLessThanOrEqual(1);
    expect(secondPage.result.list.length).toBeLessThanOrEqual(1);
  });

  test('EC-EDIT-001: edits pending employee and keeps employee retrievable', async ({ payoutApi }) => {
    const payload = validPassportEmployee({ phone: uniqueSouthAfricanPhone() });
    const created = await payoutApi.expectCreateEmployeeCustomer(payload);
    const customerUuid = employeeUuidFromCreateResponse(created);

    const editedPayload = cloneWith(payload, {
      customer_uuid: customerUuid,
      personal_data: {
        first_name: 'Edited',
        last_name: payload.personal_data.last_name,
      },
    });

    const edited = await payoutApi.expectEditEmployeeCustomer(editedPayload);
    const employee = employeeFromResponse(edited);

    expect(JSON.stringify(employee).toLowerCase()).toContain('edited');
  });

  test('EC-EDIT-003: rejects edit with missing required fields', async ({ payoutApi }) => {
    const payload = validPassportEmployee({ phone: uniqueSouthAfricanPhone() });
    const created = await payoutApi.expectCreateEmployeeCustomer(payload);
    const customerUuid = employeeUuidFromCreateResponse(created);

    const invalidEdit = cloneWith(payload, {
      customer_uuid: customerUuid,
      personal_data: {
        first_name: '',
      },
    });

    const response = await payoutApi.editEmployeeCustomer(invalidEdit);

    expect(response.ok()).toBeFalsy();
  });

  test('EC-EDIT-004: rejects clearing phone via change-phone endpoint', async ({ payoutApi }) => {
    const payload = validPassportEmployee({ phone: uniqueSouthAfricanPhone() });
    const created = await payoutApi.expectCreateEmployeeCustomer(payload);
    const customerUuid = employeeUuidFromCreateResponse(created);

    const response = await payoutApi.changeEmployeePhone({
      customer_uuid: customerUuid,
      phone: '',
    });

    expect(response.ok()).toBeFalsy();
  });

  test('EC-EDIT-006 EC-DETAIL-006: audit history is available for created employee', async ({ payoutApi }) => {
    const payload = validPassportEmployee({ phone: uniqueSouthAfricanPhone() });
    const created = await payoutApi.expectCreateEmployeeCustomer(payload);
    const customerUuid = employeeUuidFromCreateResponse(created);

    const audit = await payoutApi.getEmployeeAuditHistory(customerUuid, { limit: 10, offset: 0 });

    expect(audit.result).toBeTruthy();
  });
});
