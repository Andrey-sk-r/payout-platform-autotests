const { test, expect } = require('../../fixtures/payout-api-fixture');

const malformedUuid = 'not-a-uuid';
const nonExistentUuid = '00000000-0000-4000-8000-000000000000';

const protectedRoutes = [
  { id: 'LIST', path: '/v1/payout-platform/provider-job/list' },
  {
    id: 'GET-STATUS',
    path: '/v1/payout-platform/provider-job/get-status',
    options: { params: { job_uuid: nonExistentUuid } },
  },
];

function providerJobsFrom(body) {
  return body?.result?.list || [];
}

function expectJobShape(job) {
  expect(job, 'provider job').toBeTruthy();
  expect(job.job_uuid, 'job_uuid').toBeTruthy();
  expect(typeof job.job_uuid).toBe('string');
  expect(job.job_status, 'job_status').toBeTruthy();
  expect(typeof job.job_status).toBe('string');
  expect(job.operation_type, 'operation_type').toBeTruthy();
  expect(typeof job.operation_type).toBe('string');
  expect(job.provider_code, 'provider_code').toBeTruthy();
  expect(typeof job.provider_code).toBe('string');
  expect(Number.isInteger(job.retry_count), 'retry_count').toBeTruthy();
  expect(Number.isInteger(job.max_retries), 'max_retries').toBeTruthy();
}

async function expectNonOk(response, message) {
  expect(response.ok(), message).toBeFalsy();
}

test.describe('Payout Platform provider job API', () => {
  for (const route of protectedRoutes) {
    test(`JOB-AUTH-NEG-${route.id}: GET ${route.path} rejects unauthenticated request`, async ({ request }) => {
      const response = await request.get(route.path, route.options || {});

      await expectNonOk(response, `${route.path} must require authentication`);
    });
  }

  test('JOB-LIST-001: provider-job/list returns list shape and provider job item contract when rows exist', async ({ payoutApi }) => {
    const body = await payoutApi.listProviderJobs({ limit: 10, offset: 0 });
    const list = providerJobsFrom(body);

    expect(body.meta, 'response meta').toBeTruthy();
    expect(body.result, 'response result').toBeTruthy();
    expect(Array.isArray(list), 'result.list').toBeTruthy();
    expect(list.length).toBeLessThanOrEqual(10);

    for (const job of list) {
      expectJobShape(job);
    }
  });

  test('JOB-LIST-002: provider-job/list supports limit and offset pagination boundaries', async ({ payoutApi }) => {
    const firstPage = await payoutApi.listProviderJobs({ limit: 1, offset: 0 });
    const secondPage = await payoutApi.listProviderJobs({ limit: 1, offset: 1 });

    expect(providerJobsFrom(firstPage).length).toBeLessThanOrEqual(1);
    expect(providerJobsFrom(secondPage).length).toBeLessThanOrEqual(1);
  });

  test('JOB-LIST-004: provider-job/list filters by live provider_code, status, and operation_type when jobs exist', async ({ payoutApi }) => {
    const body = await payoutApi.listProviderJobs({ limit: 10, offset: 0 });
    const sample = providerJobsFrom(body)[0];
    test.skip(!sample, 'No provider jobs exist in this organisation.');

    for (const filters of [
      { provider_code: sample.provider_code },
      { status: sample.job_status },
      { operation_type: sample.operation_type },
    ]) {
      const filtered = await payoutApi.listProviderJobs({ ...filters, limit: 10, offset: 0 });
      const list = providerJobsFrom(filtered);
      expect(list.some((job) => job.job_uuid === sample.job_uuid), `provider-job/list filter ${JSON.stringify(filters)}`).toBeTruthy();
    }
  });

  test('JOB-LIST-003: provider-job/list accepts limit zero and returns list shape despite swagger minimum', async ({ payoutApi }) => {
    const body = await payoutApi.listProviderJobs({ limit: 0, offset: 0 });
    const list = providerJobsFrom(body);

    expect(body.meta, 'response meta').toBeTruthy();
    expect(body.result, 'response result').toBeTruthy();
    expect(Array.isArray(list), 'result.list').toBeTruthy();
  });

  test('JOB-LIST-NEG-002: provider-job/list rejects limit above swagger maximum', async ({ payoutApi }) => {
    const response = await payoutApi.get('/v1/payout-platform/provider-job/list', {
      params: { limit: 101, offset: 0 },
    });

    await expectNonOk(response, 'limit=101 must be rejected according to swagger maximum 100');
  });

  test('JOB-LIST-NEG-003: provider-job/list rejects negative offset', async ({ payoutApi }) => {
    const response = await payoutApi.get('/v1/payout-platform/provider-job/list', {
      params: { limit: 10, offset: -1 },
    });

    await expectNonOk(response, 'offset=-1 must be rejected according to swagger minimum 0');
  });

  test('JOB-STATUS-001: provider-job/get-status returns status for a live job when jobs exist', async ({ payoutApi }) => {
    const body = await payoutApi.listProviderJobs({ limit: 1, offset: 0 });
    const sample = providerJobsFrom(body)[0];
    test.skip(!sample, 'No provider jobs exist in this organisation.');

    const statusBody = await payoutApi.getProviderJobStatus(sample.job_uuid);

    expect(statusBody.meta, 'response meta').toBeTruthy();
    expect(statusBody.result, 'response result').toBeTruthy();
    expect(JSON.stringify(statusBody)).toContain(sample.job_uuid);
  });

  test('JOB-STATUS-NEG-001: provider-job/get-status rejects missing job_uuid', async ({ payoutApi }) => {
    const response = await payoutApi.get('/v1/payout-platform/provider-job/get-status');

    await expectNonOk(response, 'missing job_uuid must be rejected');
  });

  test('JOB-STATUS-NEG-002: provider-job/get-status rejects malformed job_uuid', async ({ payoutApi }) => {
    const response = await payoutApi.get('/v1/payout-platform/provider-job/get-status', {
      params: { job_uuid: malformedUuid },
    });

    await expectNonOk(response, 'malformed job_uuid must be rejected');
  });

  test('JOB-STATUS-NEG-003: provider-job/get-status rejects non-existent job_uuid', async ({ payoutApi }) => {
    const response = await payoutApi.get('/v1/payout-platform/provider-job/get-status', {
      params: { job_uuid: nonExistentUuid },
    });

    await expectNonOk(response, 'non-existent job_uuid must be rejected');
  });
});
