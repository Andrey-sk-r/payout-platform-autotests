const { test, expect } = require('../../fixtures/payout-api-fixture');
const { optionalEnv, requiredEnv } = require('../../../src/config/env');

function batchFrom(body) {
  return body?.result?.batch;
}

function batchLines(batch) {
  return batch?.line_items || batch?.draft_line_items || [];
}

function lineUuid(line) {
  return line?.line_uuid || line?.uuid;
}

function firstEftDestination(body) {
  const list = body?.result?.list || [];
  return list.find((destination) => destination.rail === 'eft' && destination.destination_uuid) || null;
}

function firstNonEmptyBatch(body) {
  const list = body?.result?.list || [];
  return list.find((batch) => Number(batch.total_count || 0) > 0) || null;
}

async function expectOkJson(response, label) {
  await expect(response, label).toBeOK();
  return response.json();
}

async function createSubmittedBatchWithLine(payoutApi, runId, testInfo) {
  const destinationsBody = await payoutApi.listBeneficiaryDestinations({
    status: 'approved',
    disabled: false,
    per_page: 20,
  });
  const destination = firstEftDestination(destinationsBody);
  expect(destination, 'approved EFT destination is required').toBeTruthy();

  const createBody = await expectOkJson(await payoutApi.createBatch({
    name: `Codex API Guard Flow ${runId}`,
    client_batch_reference: `CODEX-API-GUARD-FLOW-${runId}`,
  }), 'create guard batch');
  const batchUuid = batchFrom(createBody).batch_uuid;
  testInfo.annotations.push({ type: 'batch_uuid', description: batchUuid });

  await expectOkJson(await payoutApi.addBatchDraftLine({
    batch_uuid: batchUuid,
    destination_uuid: destination.destination_uuid,
    amount: '11.00',
    reference: `Codex API guard ${runId}`,
    internal_reference: `CODEX-API-GUARD-${runId}`,
  }), 'add guard draft line');

  await expectOkJson(await payoutApi.submitBatch({
    batch_uuid: batchUuid,
    force_submit: true,
  }), 'submit guard batch');

  const detail = await payoutApi.getBatchByUuid(batchUuid);
  const submittedLine = batchLines(batchFrom(detail))[0];
  const submittedLineUuid = lineUuid(submittedLine);
  expect(submittedLineUuid, 'submitted line uuid').toBeTruthy();

  return {
    batchUuid,
    destination,
    submittedLineUuid,
  };
}

test.describe('Payout Platform batch API full flow', () => {
  test.skip(process.env.PLATFORM_ENV !== 'stage', 'Full batch mutation flow is currently approved only for stage/preprod2.');
  test.skip(optionalEnv('ALLOW_MUTATING_BATCH_TESTS') !== 'true', 'Set ALLOW_MUTATING_BATCH_TESTS=true to create and approve real stage batches.');

  test('BATCH-FLOW-001: create, return for edit, update, resubmit, and approve batch', async ({ payoutApi }, testInfo) => {
    const runId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const destinationsBody = await payoutApi.listBeneficiaryDestinations({
      status: 'approved',
      disabled: false,
      per_page: 20,
    });
    const destination = firstEftDestination(destinationsBody);

    expect(destination, 'approved EFT destination is required').toBeTruthy();

    const batchName = `Codex API Full Flow ${runId}`;
    const createBody = await expectOkJson(await payoutApi.createBatch({
      name: batchName,
      client_batch_reference: `CODEX-API-FULL-FLOW-${runId}`,
    }), 'create batch');
    const batchUuid = batchFrom(createBody).batch_uuid;
    testInfo.annotations.push({ type: 'batch_uuid', description: batchUuid });

    const addLineBody = await expectOkJson(await payoutApi.addBatchDraftLine({
      batch_uuid: batchUuid,
      destination_uuid: destination.destination_uuid,
      amount: '11.00',
      reference: `Codex API flow ${runId}`,
      internal_reference: `CODEX-API-${runId}`,
    }), 'add draft line');
    const draftLine = batchLines(batchFrom(addLineBody))[0];
    const draftLineUuid = lineUuid(draftLine);

    expect(batchFrom(addLineBody).status).toBe('draft');
    expect(draftLineUuid, 'draft line uuid').toBeTruthy();
    expect(draftLine.validation_status).toBe('valid');
    expect(draftLine.internal_reference).toBe(`CODEX-API-${runId}`);

    const submitBody = await expectOkJson(await payoutApi.submitBatch({
      batch_uuid: batchUuid,
      force_submit: true,
    }), 'submit batch');
    expect(batchFrom(submitBody).status).toBe('submitted');

    const submittedDetail = await payoutApi.getBatchByUuid(batchUuid);
    const submittedLine = batchLines(batchFrom(submittedDetail))[0];
    const submittedLineUuid = lineUuid(submittedLine);

    expect(submittedLineUuid, 'submitted line uuid').toBeTruthy();
    expect(submittedLineUuid, 'submitted line uuid is recreated from draft line').not.toBe(draftLineUuid);

    const markBody = await expectOkJson(await payoutApi.markBatchLineForEdit({
      line_uuid: submittedLineUuid,
      reason: 'Codex API full flow amount correction',
    }), 'mark line for edit');
    expect(batchLines(batchFrom(markBody))[0].status).toBe('marked_for_edit');

    const returnBody = await expectOkJson(await payoutApi.returnBatchForEdit({
      batch_uuid: batchUuid,
      reason: 'Codex API full flow returned for edit',
    }), 'return batch for edit');
    expect(batchFrom(returnBody).status).toBe('returned_for_edit');

    const updateBody = await expectOkJson(await payoutApi.updateBatchLine({
      line_uuid: submittedLineUuid,
      destination_uuid: destination.destination_uuid,
      amount: '12.00',
      reference: `Codex API corrected ${runId}`,
      internal_reference: `CODEX-API-CORRECTED-${runId}`,
    }), 'update returned line');
    const updatedLine = batchLines(batchFrom(updateBody))[0];
    expect(updatedLine.amount).toBe('12');
    expect(updatedLine.reference).toBe(`Codex API corrected ${runId}`);
    expect(updatedLine.internal_reference).toBe(`CODEX-API-CORRECTED-${runId}`);
    expect(updatedLine.status).toBe('marked_for_edit');

    const resubmitBody = await expectOkJson(await payoutApi.submitBatch({
      batch_uuid: batchUuid,
      force_submit: true,
    }), 'resubmit returned batch');
    expect(batchFrom(resubmitBody).status).toBe('submitted');

    const cancelMarkBody = await expectOkJson(await payoutApi.cancelBatchLineMarkForEdit({
      line_uuid: submittedLineUuid,
    }), 'cancel mark after resubmit');
    expect(batchLines(batchFrom(cancelMarkBody))[0].status).toBe('queued');

    await expectOkJson(await payoutApi.requestBatchApprovalOtp({
      batch_uuid: batchUuid,
    }), 'request batch approval OTP');

    const approveBody = await expectOkJson(await payoutApi.approveBatch({
      batch_uuid: batchUuid,
      email_otp: requiredEnv('PLATFORM_EMAIL_OTP'),
      phone_otp: requiredEnv('PLATFORM_APPROVAL_PHONE_OTP'),
      force_approve: true,
    }), 'approve batch');

    expect(approveBody.result.approve_status).toBe('success');
    expect(batchFrom(approveBody).status).toBe('approved');

    const approvedDetail = await payoutApi.getBatchByUuid(batchUuid);
    expect(batchFrom(approvedDetail).status).toBe('approved');
    expect(batchLines(batchFrom(approvedDetail))[0].amount).toBe('12');
    expect(batchLines(batchFrom(approvedDetail))[0].internal_reference).toBe(`CODEX-API-CORRECTED-${runId}`);
  });

  test('BATCH-FLOW-002: marked line guards block invalid cancel and approval states', async ({ payoutApi }, testInfo) => {
    const runId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const { batchUuid, destination, submittedLineUuid } = await createSubmittedBatchWithLine(payoutApi, runId, testInfo);

    const markBody = await expectOkJson(await payoutApi.markBatchLineForEdit({
      line_uuid: submittedLineUuid,
      reason: 'Codex API guard correction',
    }), 'mark guard line for edit');
    expect(batchLines(batchFrom(markBody))[0].status).toBe('marked_for_edit');

    const returnBody = await expectOkJson(await payoutApi.returnBatchForEdit({
      batch_uuid: batchUuid,
      reason: 'Codex API guard returned for edit',
    }), 'return guard batch for edit');
    expect(batchFrom(returnBody).status).toBe('returned_for_edit');

    const cancelWhileReturnedResponse = await payoutApi.cancelBatchLineMarkForEdit({
      line_uuid: submittedLineUuid,
    });
    expect(cancelWhileReturnedResponse.ok(), 'cancel mark must be blocked while returned_for_edit').toBeFalsy();
    const cancelWhileReturnedBody = await cancelWhileReturnedResponse.json();
    expect(cancelWhileReturnedBody.error.code).toBe('not_allowed');
    expect(cancelWhileReturnedBody.error.detail).toContain("status 'returned_for_edit'");

    await expectOkJson(await payoutApi.updateBatchLine({
      line_uuid: submittedLineUuid,
      destination_uuid: destination.destination_uuid,
      amount: '13.00',
      reference: `Codex API guard corrected ${runId}`,
      internal_reference: `CODEX-API-GUARD-CORRECTED-${runId}`,
    }), 'update guard returned line');

    const resubmitBody = await expectOkJson(await payoutApi.submitBatch({
      batch_uuid: batchUuid,
      force_submit: true,
    }), 'resubmit guard batch');
    expect(batchFrom(resubmitBody).status).toBe('submitted');

    await expectOkJson(await payoutApi.requestBatchApprovalOtp({
      batch_uuid: batchUuid,
    }), 'request guard approval OTP');

    const approveWhileMarkedResponse = await payoutApi.approveBatch({
      batch_uuid: batchUuid,
      email_otp: requiredEnv('PLATFORM_EMAIL_OTP'),
      phone_otp: requiredEnv('PLATFORM_APPROVAL_PHONE_OTP'),
      force_approve: true,
    });
    expect(approveWhileMarkedResponse.ok(), 'approve must be blocked while submitted line is marked_for_edit').toBeFalsy();
    const approveWhileMarkedBody = await approveWhileMarkedResponse.json();
    expect(approveWhileMarkedBody.error.code).toBe('not_allowed');
    expect(approveWhileMarkedBody.error.detail).toContain('marked for edit');

    const cancelMarkBody = await expectOkJson(await payoutApi.cancelBatchLineMarkForEdit({
      line_uuid: submittedLineUuid,
    }), 'cancel guard mark after resubmit');
    expect(batchLines(batchFrom(cancelMarkBody))[0].status).toBe('queued');

    await expectOkJson(await payoutApi.requestBatchApprovalOtp({
      batch_uuid: batchUuid,
    }), 'request fresh guard approval OTP after failed approve');

    const approveBody = await expectOkJson(await payoutApi.approveBatch({
      batch_uuid: batchUuid,
      email_otp: requiredEnv('PLATFORM_EMAIL_OTP'),
      phone_otp: requiredEnv('PLATFORM_APPROVAL_PHONE_OTP'),
      force_approve: true,
    }), 'approve guard batch after cancel mark');
    expect(approveBody.result.approve_status).toBe('success');
    expect(batchFrom(approveBody).status).toBe('approved');
  });

  test('BATCH-FLOW-003: compare submitted batch with historical batch returns stable contract shape', async ({ payoutApi }, testInfo) => {
    const runId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const { batchUuid } = await createSubmittedBatchWithLine(payoutApi, runId, testInfo);
    const completedBody = await payoutApi.listBatches({
      status: 'completed_success',
      limit: 20,
      offset: 0,
    });
    const historical = firstNonEmptyBatch(completedBody);

    test.skip(!historical, 'A non-empty completed_success historical batch is required for compare contract coverage.');

    const compareBody = await expectOkJson(await payoutApi.compareBatchWithHistorical({
      current_batch_uuid: batchUuid,
      historical_batch_uuid: historical.batch_uuid,
    }), 'compare batch with historical');

    expect(compareBody.result).toBeTruthy();
    expect(compareBody.result.summary).toBeTruthy();
    expect(Array.isArray(compareBody.result.existing_in_both)).toBeTruthy();
    expect(Array.isArray(compareBody.result.only_in_new)).toBeTruthy();
    expect(Array.isArray(compareBody.result.only_in_historical)).toBeTruthy();

    await expectOkJson(await payoutApi.requestBatchApprovalOtp({
      batch_uuid: batchUuid,
    }), 'request compare-flow approval OTP');

    const approveBody = await expectOkJson(await payoutApi.approveBatch({
      batch_uuid: batchUuid,
      email_otp: requiredEnv('PLATFORM_EMAIL_OTP'),
      phone_otp: requiredEnv('PLATFORM_APPROVAL_PHONE_OTP'),
      force_approve: true,
    }), 'approve compare-flow batch after contract check');
    expect(approveBody.result.approve_status).toBe('success');
    expect(batchFrom(approveBody).status).toBe('approved');
  });
});
