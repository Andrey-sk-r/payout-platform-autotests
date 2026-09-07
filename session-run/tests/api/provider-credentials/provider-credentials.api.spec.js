const { test, expect } = require('../../fixtures/payout-api-fixture');
const { optionalEnv } = require('../../../src/config/env');

const malformedUuid = 'not-a-uuid';
const nonExistentUuid = '00000000-0000-4000-8000-000000000000';
const sampleValidProviderCode = 'payroll';
const longValue = 'x'.repeat(501);

const protectedRoutes = [
  { id: 'LIST', method: 'get', path: '/v1/payout-platform/provider-credential/get-list' },
  { id: 'GET', method: 'get', path: '/v1/payout-platform/provider-credential/get-by-uuid', options: { params: { uuid: nonExistentUuid } } },
  { id: 'CREATE', method: 'post', path: '/v1/payout-platform/provider-credential/create', options: { data: {} } },
  { id: 'UPDATE', method: 'post', path: '/v1/payout-platform/provider-credential/update', options: { data: {} } },
  { id: 'ACTIVE', method: 'post', path: '/v1/payout-platform/provider-credential/update-active', options: { data: {} } },
  { id: 'APIKEY', method: 'post', path: '/v1/payout-platform/provider-credential/update-apikey', options: { data: {} } },
  { id: 'DELETE', method: 'post', path: '/v1/payout-platform/provider-credential/delete', options: { data: {} } },
];

function providerCredentialFromList(body) {
  const list = body?.result?.list || body?.result?.provider_credential_list || [];
  return list[0] || null;
}

function providerCredentialUuid(credential) {
  return credential?.uuid || credential?.provider_credential_uuid || credential?.provider_integration_uuid;
}

function expectProviderCredentialShape(credential) {
  expect(credential).toBeTruthy();
  expect(providerCredentialUuid(credential), 'provider credential uuid').toBeTruthy();
  expect(credential.name, 'provider credential name').toBeTruthy();
  expect(credential.provider_code, 'provider code').toBeTruthy();
  expect(credential.api_key, 'api key must not be exposed').toBeUndefined();
}

async function expectNonOk(response, message) {
  expect(response.ok(), message).toBeFalsy();
}

async function firstProviderCredentialUuid(payoutApi) {
  const listBody = await payoutApi.listProviderCredentials();
  const credential = providerCredentialFromList(listBody);
  return providerCredentialUuid(credential);
}

async function disposableProviderCode() {
  // Stage only permits test credentials for SimplePay.  The first credential in
  // the list can belong to a different provider, so it is not a valid source
  // for a disposable create/update/delete flow.
  return optionalEnv('PROVIDER_CREDENTIAL_PROVIDER_CODE', 'simplepay');
}

test.describe('Payout Platform provider credential API', () => {
  for (const route of protectedRoutes) {
    test(`PC-AUTH-NEG-${route.id}: ${route.method.toUpperCase()} ${route.path} rejects unauthenticated request`, async ({ request }) => {
      const response = await request[route.method](route.path, route.options || {});

      await expectNonOk(response, `${route.path} must require authentication`);
    });
  }

  test('PC-LIST-001: get-list returns provider credentials without exposing API keys', async ({ payoutApi }) => {
    const body = await payoutApi.listProviderCredentials();

    expect(body.meta).toBeTruthy();
    expect(body.result).toBeTruthy();

    const list = body.result.list || body.result.provider_credential_list || [];
    expect(Array.isArray(list)).toBeTruthy();
    for (const credential of list) {
      expect(credential.api_key, 'api key must not be exposed in list').toBeUndefined();
      expect(credential.provider_code, 'provider code').toBeTruthy();
    }
  });

  test('PC-LIST-002: get-list filters by provider_code, name, client_id, and is_active', async ({ payoutApi }) => {
    const suffix = Date.now();
    const providerCode = await disposableProviderCode(payoutApi);
    const name = `QA Filterable Provider Credential ${suffix}`;
    const clientId = `qa-filter-client-${suffix}`;
    let uuid;

    expect(providerCode, 'An existing provider_code is required for the list filter test').toBeTruthy();

    try {
      const createResponse = await payoutApi.createProviderCredential({
        name,
        provider_code: providerCode,
        client_id: clientId,
        api_key: `qa-filter-api-key-${suffix}`,
        is_active: true,
      });
      await expect(createResponse, 'create filterable provider credential').toBeOK();
      uuid = providerCredentialUuid((await createResponse.json()).result.credential);

      for (const filters of [
        { provider_code: providerCode },
        { name },
        { client_id: clientId },
        { is_active: true },
      ]) {
        const body = await payoutApi.listProviderCredentials(filters);
        const list = body.result.list || [];
        expect(list.some((credential) => providerCredentialUuid(credential) === uuid), `get-list filter ${JSON.stringify(filters)}`).toBeTruthy();
      }

      const activeResponse = await payoutApi.updateProviderCredentialActive({ uuid, is_active: false });
      await expect(activeResponse, 'deactivate filterable provider credential').toBeOK();
      const inactiveBody = await payoutApi.listProviderCredentials({ is_active: false, name });
      expect((inactiveBody.result.list || []).some((credential) => providerCredentialUuid(credential) === uuid)).toBeTruthy();
    } finally {
      if (uuid) {
        const cleanupResponse = await payoutApi.deleteProviderCredential({ uuid });
        await expect(cleanupResponse, 'cleanup filterable provider credential').toBeOK();
      }
    }
  });

  test('PC-LIST-003: get-list accepts limit zero and returns list shape', async ({ payoutApi }) => {
    const body = await payoutApi.listProviderCredentials({ limit: 0 });
    const list = body.result.list || body.result.provider_credential_list || [];

    expect(Array.isArray(list)).toBeTruthy();
  });

  for (const testCase of [
    { id: '002', title: 'limit above maximum', params: { limit: 101 } },
    { id: '003', title: 'negative offset', params: { offset: -1 } },
  ]) {
    test(`PC-LIST-NEG-${testCase.id}: get-list rejects ${testCase.title}`, async ({ payoutApi }) => {
      const response = await payoutApi.get('/v1/payout-platform/provider-credential/get-list', {
        params: testCase.params,
      });

      await expectNonOk(response, `get-list must reject ${testCase.title}`);
    });
  }

  test('PC-GET-001: get-by-uuid returns a provider credential from the list', async ({ payoutApi }) => {
    const listBody = await payoutApi.listProviderCredentials();
    const credential = providerCredentialFromList(listBody);
    test.skip(!credential, 'No provider credentials exist in this organisation.');

    const uuid = providerCredentialUuid(credential);
    const response = await payoutApi.getProviderCredentialByUuid(uuid);
    await expect(response, 'provider credential get-by-uuid').toBeOK();

    const body = await response.json();
    const resultCredential = body?.result?.credential || body?.result?.provider_credential || body?.result;
    expectProviderCredentialShape(resultCredential);
    expect(providerCredentialUuid(resultCredential)).toBe(uuid);
  });

  test('PC-GET-NEG-001: get-by-uuid rejects missing UUID', async ({ payoutApi }) => {
    const response = await payoutApi.getProviderCredentialByUuid('');

    expect(response.ok()).toBeFalsy();
  });

  test('PC-GET-NEG-002: get-by-uuid rejects malformed UUID', async ({ payoutApi }) => {
    const response = await payoutApi.getProviderCredentialByUuid(malformedUuid);

    await expectNonOk(response, 'malformed UUID must be rejected');
  });

  test('PC-GET-NEG-003: get-by-uuid rejects syntactically valid but non-existent UUID', async ({ payoutApi }) => {
    const response = await payoutApi.getProviderCredentialByUuid(nonExistentUuid);

    await expectNonOk(response, 'non-existent UUID must not return a credential');
  });

  test('PC-CREATE-NEG-001: create rejects empty body', async ({ payoutApi }) => {
    const response = await payoutApi.createProviderCredential({});

    expect(response.ok()).toBeFalsy();
  });

  const createInvalidCases = [
    {
      id: '002',
      title: 'missing name',
      data: { provider_code: sampleValidProviderCode, client_id: 'qa-client', api_key: 'qa-api-key' },
    },
    {
      id: '003',
      title: 'missing provider_code',
      data: { name: 'QA invalid provider credential', client_id: 'qa-client', api_key: 'qa-api-key' },
    },
    {
      id: '004',
      title: 'missing client_id',
      data: { name: 'QA invalid provider credential', provider_code: sampleValidProviderCode, api_key: 'qa-api-key' },
    },
    {
      id: '005',
      title: 'missing api_key',
      data: { name: 'QA invalid provider credential', provider_code: sampleValidProviderCode, client_id: 'qa-client' },
    },
    {
      id: '006',
      title: 'unknown provider_code equivalence class',
      data: { name: 'QA invalid provider credential', provider_code: `unknown-provider-${Date.now()}`, client_id: 'qa-client', api_key: 'qa-api-key' },
    },
    {
      id: '007',
      title: 'overlong boundary values',
      data: { name: longValue, provider_code: longValue, client_id: longValue, api_key: longValue },
    },
  ];

  for (const testCase of createInvalidCases) {
    test(`PC-CREATE-NEG-${testCase.id}: create rejects ${testCase.title}`, async ({ payoutApi }) => {
      const response = await payoutApi.createProviderCredential(testCase.data);

      await expectNonOk(response, `create should reject ${testCase.title}`);
    });
  }

  test('PC-UPDATE-NEG-001: update rejects empty body', async ({ payoutApi }) => {
    const response = await payoutApi.updateProviderCredential({});

    expect(response.ok()).toBeFalsy();
  });

  test('PC-UPDATE-NEG-002: update rejects malformed UUID', async ({ payoutApi }) => {
    const response = await payoutApi.updateProviderCredential({
      uuid: malformedUuid,
      name: 'QA malformed uuid',
      client_id: 'qa-client',
    });

    await expectNonOk(response, 'update must reject malformed UUID');
  });

  test('PC-UPDATE-NEG-003: update rejects non-existent UUID', async ({ payoutApi }) => {
    const response = await payoutApi.updateProviderCredential({
      uuid: nonExistentUuid,
      name: 'QA non-existent uuid',
      client_id: 'qa-client',
    });

    await expectNonOk(response, 'update must reject non-existent UUID');
  });

  test('PC-ACTIVE-NEG-001: update-active rejects empty body', async ({ payoutApi }) => {
    const response = await payoutApi.updateProviderCredentialActive({});

    expect(response.ok()).toBeFalsy();
  });

  test('PC-ACTIVE-NEG-002: update-active rejects malformed UUID', async ({ payoutApi }) => {
    const response = await payoutApi.updateProviderCredentialActive({
      uuid: malformedUuid,
      is_active: true,
    });

    await expectNonOk(response, 'update-active must reject malformed UUID');
  });

  test('PC-ACTIVE-NEG-003: update-active rejects invalid boolean type for existing credential', async ({ payoutApi }) => {
    const uuid = await firstProviderCredentialUuid(payoutApi);
    test.skip(!uuid, 'No provider credentials exist in this organisation.');

    const response = await payoutApi.updateProviderCredentialActive({
      uuid,
      is_active: 'true',
    });

    await expectNonOk(response, 'update-active must reject string boolean');
  });

  test('PC-ACTIVE-NEG-004: update-active rejects non-existent UUID', async ({ payoutApi }) => {
    const response = await payoutApi.updateProviderCredentialActive({
      uuid: nonExistentUuid,
      is_active: true,
    });

    await expectNonOk(response, 'update-active must reject non-existent UUID');
  });

  test('PC-APIKEY-NEG-001: update-apikey rejects empty body', async ({ payoutApi }) => {
    const response = await payoutApi.updateProviderCredentialApiKey({});

    expect(response.ok()).toBeFalsy();
  });

  test('PC-APIKEY-NEG-002: update-apikey rejects malformed UUID', async ({ payoutApi }) => {
    const response = await payoutApi.updateProviderCredentialApiKey({
      uuid: malformedUuid,
      api_key: 'qa-api-key',
    });

    await expectNonOk(response, 'update-apikey must reject malformed UUID');
  });

  test('PC-APIKEY-NEG-003: update-apikey rejects empty API key for existing credential', async ({ payoutApi }) => {
    const uuid = await firstProviderCredentialUuid(payoutApi);
    test.skip(!uuid, 'No provider credentials exist in this organisation.');

    const response = await payoutApi.updateProviderCredentialApiKey({
      uuid,
      api_key: '',
    });

    await expectNonOk(response, 'update-apikey must reject empty API key');
  });

  test('PC-APIKEY-NEG-004: update-apikey rejects non-existent UUID', async ({ payoutApi }) => {
    const response = await payoutApi.updateProviderCredentialApiKey({
      uuid: nonExistentUuid,
      api_key: 'qa-api-key',
    });

    await expectNonOk(response, 'update-apikey must reject non-existent UUID');
  });

  test('PC-DELETE-NEG-001: delete rejects empty body', async ({ payoutApi }) => {
    const response = await payoutApi.deleteProviderCredential({});

    expect(response.ok()).toBeFalsy();
  });

  test('PC-DELETE-NEG-002: delete rejects malformed UUID', async ({ payoutApi }) => {
    const response = await payoutApi.deleteProviderCredential({
      uuid: malformedUuid,
    });

    await expectNonOk(response, 'delete must reject malformed UUID');
  });

  test('PC-DELETE-NEG-003: delete rejects non-existent UUID', async ({ payoutApi }) => {
    const response = await payoutApi.deleteProviderCredential({
      uuid: nonExistentUuid,
    });

    await expectNonOk(response, 'delete must reject non-existent UUID');
  });

  test('PC-CRUD-001: create, get, update, update-active, update-apikey, and delete disposable provider credential', async ({ payoutApi }) => {
    const suffix = Date.now();
    const providerCode = await disposableProviderCode(payoutApi);
    const clientId = optionalEnv('PROVIDER_CREDENTIAL_CLIENT_ID', `qa-client-${suffix}`);
    const apiKey = optionalEnv('PROVIDER_CREDENTIAL_API_KEY', `qa-api-key-${suffix}`);
    let uuid;
    let deleted = false;

    expect(providerCode, 'A provider_code from env or an existing credential is required for the disposable CRUD test').toBeTruthy();

    try {
      const createResponse = await payoutApi.createProviderCredential({
        name: `QA Disposable Provider Credential ${suffix}`,
        provider_code: providerCode,
        client_id: clientId,
        api_key: apiKey,
      });
      await expect(createResponse, 'create provider credential').toBeOK();

      const createdBody = await createResponse.json();
      const created = createdBody?.result?.credential || createdBody?.result?.provider_credential || createdBody?.result;
      uuid = providerCredentialUuid(created);
      expectProviderCredentialShape(created);

      const getResponse = await payoutApi.getProviderCredentialByUuid(uuid);
      await expect(getResponse, 'get created provider credential').toBeOK();

      const updateResponse = await payoutApi.updateProviderCredential({
        uuid,
        name: `QA Disposable Provider Credential Updated ${suffix}`,
        client_id: `${clientId}-updated`,
      });
      await expect(updateResponse, 'update provider credential').toBeOK();

      const activeResponse = await payoutApi.updateProviderCredentialActive({
        uuid,
        is_active: false,
      });
      await expect(activeResponse, 'update provider credential active status').toBeOK();

      const apiKeyResponse = await payoutApi.updateProviderCredentialApiKey({
        uuid,
        api_key: `${apiKey}-updated`,
      });
      await expect(apiKeyResponse, 'update provider credential API key').toBeOK();

      const deleteResponse = await payoutApi.deleteProviderCredential({
        uuid,
      });
      await expect(deleteResponse, 'delete provider credential').toBeOK();
      deleted = true;
    } finally {
      if (uuid && !deleted) {
        const cleanupResponse = await payoutApi.deleteProviderCredential({
          uuid,
        });
        await expect(cleanupResponse, 'cleanup disposable provider credential').toBeOK();
      }
    }
  });
});
