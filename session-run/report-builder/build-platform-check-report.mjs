import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const repoRoot = path.resolve('..');
const outputDir = path.join(repoRoot, 'outputs', 'platform-check-report-20260608');
const outputPath = path.join(outputDir, 'platform-known-checks-stage-20260608.xlsx');

const apiFiles = [
  'tests/api/auth/auth.api.spec.js',
  'tests/api/batches/batch-file-upload.api.spec.js',
  'tests/api/batches/batch-full-flow.api.spec.js',
  'tests/api/batches/batch-history-states.api.spec.js',
  'tests/api/batches/batch-payroll-import.api.spec.js',
  'tests/api/batches/batch-read-contract.api.spec.js',
  'tests/api/batches/batch-state-transitions.api.spec.js',
  'tests/api/beneficiaries/beneficiaries.api.spec.js',
  'tests/api/beneficiaries/beneficiary-destination-lifecycle.api.spec.js',
  'tests/api/dashboard/dashboard.api.spec.js',
  'tests/api/employee-cards/employee-boundaries.api.spec.js',
  'tests/api/employee-cards/employee-customer-create.api.spec.js',
  'tests/api/employee-cards/employee-customer-search-edit.api.spec.js',
  'tests/api/employee-cards/employee-detail-settings.api.spec.js',
  'tests/api/employee-cards/employee-kyc-documents.api.spec.js',
  'tests/api/employee-cards/employee-uniqueness.api.spec.js',
  'tests/api/provider-credentials/provider-credentials.api.spec.js',
  'tests/api/settings/settings.api.spec.js',
  'tests/api/settings/team.api.spec.js',
];

const uiFiles = [
  'tests/ui/batch-line-view.ui.spec.js',
  'tests/ui/batch-state-pages.ui.spec.js',
  'tests/ui/history-beneficiary-search.ui.spec.js',
  'tests/ui/settings-integrations.ui.spec.js',
  'tests/ui/settings-team.ui.spec.js',
];

const failedTests = new Map([
  [
    'History beneficiary search with date range › filters completed/approved history batches by beneficiary and inclusive range',
    'UI вернул empty state "No history batches found" вместо двух ожидаемых строк: Supplier Payments Awaiting Approval и Approved Contractor Payments.',
  ],
  [
    'History beneficiary search with date range › includes rows whose Updated date is inside the selected single-day range',
    'UI вернул empty state "No history batches found" вместо строки Supplier Payments Awaiting Approval для даты 2026-05-28.',
  ],
]);

const skippedTests = new Map([
  [
    'Payout Platform batch history result states › BATCH-HISTORY-003 processing: detail exposes in-flight line statuses when rows exist',
    'Тест пропущен: на момент прогона в stage не было подходящих processing rows для проверки detail in-flight lines.',
  ],
]);

const blockRules = [
  [/auth[\\/]/, 'API Auth'],
  [/batches[\\/]/, 'API Batches'],
  [/beneficiaries[\\/]/, 'API Beneficiaries'],
  [/employee-cards[\\/]/, 'API Employee Cards'],
  [/provider-credentials[\\/]/, 'API Provider Credentials'],
  [/settings[\\/]settings\.api/, 'API Settings'],
  [/settings[\\/]team\.api/, 'API Team'],
  [/dashboard[\\/]/, 'API Dashboard'],
  [/batch-line-view|batch-state-pages/, 'UI Batches'],
  [/history-beneficiary-search/, 'UI History'],
  [/settings-integrations/, 'UI Integrations'],
  [/settings-team/, 'UI Team'],
];

function listTests(project, files) {
  const result = spawnSync('npx', ['playwright', 'test', `--project=${project}`, ...files, '--list'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: true,
    env: { ...process.env, PLATFORM_ENV: 'stage' },
  });
  if (result.status !== 0) {
    throw new Error(`Unable to list ${project} tests:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^\s+\[[^\]]+\] › (.+)$/)?.[1])
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(' › ');
      const file = parts.shift();
      const titlePath = parts.join(' › ');
      const block = blockRules.find(([pattern]) => pattern.test(file))?.[1] || project;
      return { project, file, titlePath, block };
    });
}

function expectedFromTitle(titlePath) {
  const testName = titlePath.split(' › ').at(-1);
  const afterColon = testName.includes(':') ? testName.split(':').slice(1).join(':').trim() : testName;
  return afterColon.charAt(0).toUpperCase() + afterColon.slice(1);
}

function statusFor(test) {
  if (failedTests.has(test.titlePath)) return 'Failed';
  if (skippedTests.has(test.titlePath)) return 'Skipped';
  return 'Passed';
}

function factualFor(test, status) {
  if (status === 'Failed') return failedTests.get(test.titlePath);
  if (status === 'Skipped') return skippedTests.get(test.titlePath);
  if (test.project === 'chromium') return 'UI проверка в headed-режиме прошла, фактическое поведение совпало с ожидаемым.';
  return 'API проверка на stage прошла, фактическое поведение совпало с ожидаемым.';
}

const tests = [...listTests('api', apiFiles), ...listTests('chromium', uiFiles)];
const rows = tests.map((test) => {
  const status = statusFor(test);
  return {
    block: test.block,
    action: test.titlePath,
    factual: factualFor(test, status),
    expected: expectedFromTitle(test.titlePath),
    result: status,
  };
});

const blockOrder = [
  'API Auth',
  'API Batches',
  'API Beneficiaries',
  'API Employee Cards',
  'API Provider Credentials',
  'API Settings',
  'API Team',
  'API Dashboard',
  'UI Batches',
  'UI History',
  'UI Integrations',
  'UI Team',
];

function setWidths(sheet) {
  sheet.getRange('A:A').format.columnWidthPx = 430;
  sheet.getRange('B:B').format.columnWidthPx = 430;
  sheet.getRange('C:C').format.columnWidthPx = 390;
  sheet.getRange('D:D').format.columnWidthPx = 95;
}

function styleHeader(range) {
  range.format = {
    fill: '#1F4E78',
    font: { bold: true, color: '#FFFFFF' },
    wrapText: true,
  };
}

function styleStatus(sheet, rowCount) {
  if (rowCount <= 1) return;
  for (let row = 2; row <= rowCount; row += 1) {
    const value = sheet.getRange(`D${row}`).values?.[0]?.[0];
    const range = sheet.getRange(`A${row}:D${row}`);
    if (value === 'Failed') {
      range.format.fill = '#FCE4D6';
      sheet.getRange(`D${row}`).format.font = { bold: true, color: '#C00000' };
    } else if (value === 'Skipped') {
      range.format.fill = '#FFF2CC';
      sheet.getRange(`D${row}`).format.font = { bold: true, color: '#9C6500' };
    } else {
      sheet.getRange(`D${row}`).format.font = { bold: true, color: '#006100' };
    }
  }
}

const workbook = Workbook.create();

const summary = workbook.worksheets.add('Summary');
summary.showGridLines = false;
summary.getRange('A1:D1').merge();
summary.getRange('A1').values = [['Stage known checks run - 2026-06-08']];
summary.getRange('A1').format = {
  fill: '#17365D',
  font: { bold: true, color: '#FFFFFF', size: 16 },
};
summary.getRange('A3:D3').values = [['Блок', 'Всего', 'Passed', 'Failed / Skipped']];
styleHeader(summary.getRange('A3:D3'));

const summaryRows = blockOrder.map((block) => {
  const blockRows = rows.filter((row) => row.block === block);
  const passed = blockRows.filter((row) => row.result === 'Passed').length;
  const failedOrSkipped = blockRows.length - passed;
  return [block, blockRows.length, passed, failedOrSkipped];
});
summary.getRangeByIndexes(3, 0, summaryRows.length, 4).values = summaryRows;
summary.getRange(`A${summaryRows.length + 6}:D${summaryRows.length + 6}`).values = [[
  'Scope note',
  'Card allocation/activation lifecycle and InsufficientBalance were intentionally not executed in this run.',
  '',
  '',
]];
summary.getRange(`A${summaryRows.length + 6}:D${summaryRows.length + 6}`).format.wrapText = true;
summary.getRange('A:A').format.columnWidthPx = 260;
summary.getRange('B:D').format.columnWidthPx = 120;
summary.freezePanes.freezeRows(3);

for (const block of blockOrder) {
  const blockRows = rows.filter((row) => row.block === block);
  const sheet = workbook.worksheets.add(block.slice(0, 31));
  sheet.showGridLines = false;
  sheet.getRange('A1:D1').values = [['Действие', 'Фактическое поведение', 'Ожидаемое поведение', 'Результат']];
  styleHeader(sheet.getRange('A1:D1'));
  if (blockRows.length > 0) {
    sheet.getRangeByIndexes(1, 0, blockRows.length, 4).values = blockRows.map((row) => [
      row.action,
      row.factual,
      row.expected,
      row.result,
    ]);
  }
  sheet.freezePanes.freezeRows(1);
  setWidths(sheet);
  sheet.getRangeByIndexes(0, 0, Math.max(blockRows.length + 1, 2), 4).format.wrapText = true;
  styleStatus(sheet, blockRows.length + 1);
}

await fs.mkdir(outputDir, { recursive: true });
for (const sheetName of ['Summary', ...blockOrder.map((block) => block.slice(0, 31))]) {
  const preview = await workbook.render({ sheetName, autoCrop: 'all', scale: 1, format: 'png' });
  const safeName = sheetName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  await fs.writeFile(path.join(outputDir, `${safeName}-preview.png`), new Uint8Array(await preview.arrayBuffer()));
}

const errorScan = await workbook.inspect({
  kind: 'match',
  searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',
  options: { useRegex: true, maxResults: 50 },
  summary: 'formula error scan',
});
if (errorScan.ndjson.includes('#REF!') || errorScan.ndjson.includes('#VALUE!')) {
  throw new Error(`Workbook contains formula errors:\n${errorScan.ndjson}`);
}

const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(outputPath);
console.log(outputPath);
