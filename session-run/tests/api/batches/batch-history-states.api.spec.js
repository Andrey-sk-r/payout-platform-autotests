const { test, expect } = require('../../fixtures/payout-api-fixture');

function listFrom(body) {
  return body?.result?.list || [];
}

function batchFrom(body) {
  return body?.result?.batch;
}

function batchUuid(batch) {
  return batch?.batch_uuid || batch?.uuid;
}

function batchLines(batch) {
  return batch?.line_items || batch?.draft_line_items || [];
}

async function firstNonEmptyBatchByStatus(payoutApi, status) {
  const body = await payoutApi.listBatches({
    status,
    limit: 20,
    offset: 0,
  });
  return listFrom(body).find((batch) => batchUuid(batch) && Number(batch.total_count || 0) > 0) || null;
}

test.describe('Payout Platform batch history result states', () => {
  for (const status of ['completed_success', 'completed_partial_failure', 'completed_failed', 'cancelled']) {
    test(`BATCH-HISTORY-001 ${status}: list and detail expose final-state batch lines`, async ({ payoutApi }) => {
      const sample = await firstNonEmptyBatchByStatus(payoutApi, status);
      test.skip(!sample, `No non-empty ${status} batch exists in this environment.`);

      expect(sample.status).toBe(status);

      const detailBody = await payoutApi.getBatchByUuid(batchUuid(sample));
      const detail = batchFrom(detailBody);
      const lines = batchLines(detail);

      expect(detail.status).toBe(status);
      expect(lines.length).toBeGreaterThan(0);

      if (status === 'completed_success') {
        expect(lines.every((line) => line.status === 'success')).toBeTruthy();
      }
      if (status === 'completed_failed') {
        expect(lines.some((line) => line.status === 'failed')).toBeTruthy();
      }
      if (status === 'cancelled') {
        expect(detail.changed_status_reason || detail.status).toBeTruthy();
      }
    });
  }

  for (const status of ['approved', 'processing', 'insufficient_balance']) {
    test(`BATCH-HISTORY-002 ${status}: status filter is accepted even when no rows exist`, async ({ payoutApi }) => {
      const body = await payoutApi.listBatches({
        status,
        limit: 20,
        offset: 0,
      });

      expect(Array.isArray(listFrom(body))).toBeTruthy();
      for (const batch of listFrom(body)) {
        expect(batch.status).toBe(status);
      }
    });
  }

  test('BATCH-HISTORY-003 processing: detail exposes in-flight line statuses when rows exist', async ({ payoutApi }) => {
    const sample = await firstNonEmptyBatchByStatus(payoutApi, 'processing');
    test.skip(!sample, 'No processing batch exists in this environment.');

    const detailBody = await payoutApi.getBatchByUuid(batchUuid(sample));
    const detail = batchFrom(detailBody);
    const lines = batchLines(detail);

    expect(detail.status).toBe('processing');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => ['queued', 'processing', 'send'].includes(line.status))).toBeTruthy();
  });

  test('BATCH-HISTORY-004 continue execution is guarded outside insufficient balance state', async ({ payoutApi }) => {
    const sample = await firstNonEmptyBatchByStatus(payoutApi, 'completed_failed')
      || await firstNonEmptyBatchByStatus(payoutApi, 'cancelled');
    test.skip(!sample, 'No completed_failed or cancelled batch exists to check continue-execution guard.');

    const response = await payoutApi.continueBatchExecution({
      batch_uuid: batchUuid(sample),
    });
    const body = await response.json();

    expect(response.ok()).toBeFalsy();
    expect(body).toMatchObject({
      error: {
        code: 'not_allowed',
      },
    });
    expect(body.error?.detail).toContain('Only batches with InsufficientBalance can be continued');
  });
});
