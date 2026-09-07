const { test, expect } = require('../../fixtures/payout-api-fixture');

test.describe('Payout Platform settings API', () => {
  test('returns current user profile', async ({ payoutApi }) => {
    const body = await payoutApi.me();

    expect(body.meta).toBeTruthy();
    expect(body.result.user).toBeTruthy();
    expect(body.result.user.email).toBeTruthy();
  });

  test('returns organisation info without exposing provider API keys', async ({ payoutApi }) => {
    const body = await payoutApi.organisationInfo();

    expect(body.meta).toBeTruthy();
    expect(body.result.organisation).toBeTruthy();

    const credentials = body.result.provider_credential_list || [];
    for (const credential of credentials) {
      expect(credential.api_key).toBeUndefined();
    }
  });
});
