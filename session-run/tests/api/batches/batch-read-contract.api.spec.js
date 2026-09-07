const { test, expect } = require('../../fixtures/payout-api-fixture');

function listFrom(body) {
  return body?.result?.list || [];
}

function batchUuid(batch) {
  return batch?.batch_uuid || batch?.uuid;
}

function batchLines(batch) {
  return batch?.line_items || batch?.draft_line_items || [];
}

test.describe('Payout Platform batch API read contracts', () => {
  for (const status of ['draft', 'submitted', 'returned_for_edit']) {
    test(`BATCH-LIST-001 ${status}: get-list status filter returns matching statuses`, async ({ payoutApi }) => {
      const body = await payoutApi.listBatches({
        status,
        limit: 20,
        offset: 0,
      });
      const list = listFrom(body);

      test.skip(list.length === 0, `No ${status} batches exist in this environment.`);
      expect(list.every((batch) => batch.status === status)).toBeTruthy();
    });
  }

  test('BATCH-DETAIL-001: get-by-uuid include_items returns batch detail and line array', async ({ payoutApi }) => {
    let sample;
    for (const status of ['submitted', 'returned_for_edit', 'draft', 'completed_success']) {
      const body = await payoutApi.listBatches({
        status,
        limit: 20,
        offset: 0,
      });
      sample = listFrom(body).find((batch) => batchUuid(batch) && Number(batch.total_count || 0) > 0);
      if (sample) break;
    }

    test.skip(!sample, 'No non-empty batch exists for detail contract coverage.');

    const detailBody = await payoutApi.getBatchByUuid(batchUuid(sample));
    const batch = detailBody.result.batch;

    expect(batchUuid(batch)).toBe(batchUuid(sample));
    expect(batch.status).toBeTruthy();
    expect(Array.isArray(batchLines(batch))).toBeTruthy();
    expect(batchLines(batch).length).toBeGreaterThan(0);
  });
});
