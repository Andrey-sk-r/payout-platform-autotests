const { test, expect } = require('../../fixtures/payout-api-fixture');

function dashboardFrom(body) {
  return body?.result?.dashboard || body?.dashboard || body?.result;
}

async function expectNonOk(response, message) {
  expect(response.ok(), message).toBeFalsy();
}

test.describe('Payout Platform dashboard API', () => {
  for (const route of [
    { id: 'MAIN', path: '/v1/payout-platform/dashboard/get' },
    { id: 'EMPLOYEE-CUSTOMER', path: '/v1/payout-platform/dashboard/get-employee-customer' },
  ]) {
    test(`DASH-AUTH-NEG-${route.id}: GET ${route.path} rejects unauthenticated request`, async ({ request }) => {
      const response = await request.get(route.path);

      await expectNonOk(response, `${route.path} must require authentication`);
    });
  }

  test('DASH-GET-001: dashboard/get returns dashboard object for overview widgets', async ({ payoutApi }) => {
    const body = await payoutApi.getDashboard();
    const dashboard = dashboardFrom(body);

    expect(body.meta, 'response meta').toBeTruthy();
    expect(dashboard, 'dashboard object').toBeTruthy();
    expect(typeof dashboard).toBe('object');
    expect(Object.keys(dashboard).length, 'dashboard object should not be empty').toBeGreaterThan(0);
  });

  test('DASH-GET-002: dashboard/get-employee-customer returns employee dashboard object', async ({ payoutApi }) => {
    const body = await payoutApi.getEmployeeCustomerDashboard();
    const dashboard = dashboardFrom(body);

    expect(body.meta, 'response meta').toBeTruthy();
    expect(dashboard, 'employee customer dashboard object').toBeTruthy();
    expect(typeof dashboard).toBe('object');
    expect(Object.keys(dashboard).length, 'employee dashboard object should not be empty').toBeGreaterThan(0);
  });
});
