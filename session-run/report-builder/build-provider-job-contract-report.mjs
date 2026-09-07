import fs from 'node:fs/promises';
import path from 'node:path';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const repoRoot = path.resolve('..');
const outputDir = path.join(repoRoot, 'outputs', 'provider-job-contracts-20260608');
const outputPath = path.join(outputDir, 'provider-job-contract-tests-stage-20260608.xlsx');

const rows = [
  [
    'GET /v1/payout-platform/provider-job/list',
    'JOB-AUTH-NEG-LIST: unauthenticated request',
    'Запрос без Authorization отклоняется.',
    'Запрос без Authorization отклонен non-2xx ответом.',
    'Passed',
  ],
  [
    'GET /v1/payout-platform/provider-job/get-status',
    'JOB-AUTH-NEG-GET-STATUS: unauthenticated request',
    'Запрос без Authorization отклоняется.',
    'Запрос без Authorization отклонен non-2xx ответом.',
    'Passed',
  ],
  [
    'GET /v1/payout-platform/provider-job/list',
    'JOB-LIST-001: list shape and item contract',
    'Ответ содержит meta, result.list; job item содержит job_uuid, job_status, operation_type, provider_code, retry_count, max_retries.',
    'Ответ содержит meta/result/list; все live job rows соответствуют ожидаемому shape.',
    'Passed',
  ],
  [
    'GET /v1/payout-platform/provider-job/list',
    'JOB-LIST-002: limit/offset pagination',
    'limit=1 offset=0 и limit=1 offset=1 возвращают не более одной строки.',
    'Обе страницы вернули list shape и не более одной строки.',
    'Passed',
  ],
  [
    'GET /v1/payout-platform/provider-job/list',
    'JOB-LIST-004: filters by live provider_code/status/operation_type',
    'Фильтры provider_code, status, operation_type возвращают live job из исходной выборки.',
    'Фильтры по live значениям вернули ожидаемый job_uuid.',
    'Passed',
  ],
  [
    'GET /v1/payout-platform/provider-job/list',
    'JOB-LIST-003: limit=0 current stage behavior',
    'Stage возвращает валидный list response shape для limit=0, несмотря на swagger minimum=1.',
    'limit=0 принят; ответ содержит meta, result и result.list.',
    'Passed',
  ],
  [
    'GET /v1/payout-platform/provider-job/list',
    'JOB-LIST-NEG-002: limit above maximum',
    'limit=101 отклоняется, потому что swagger maximum=100.',
    'limit=101 отклонен non-2xx ответом.',
    'Passed',
  ],
  [
    'GET /v1/payout-platform/provider-job/list',
    'JOB-LIST-NEG-003: negative offset',
    'offset=-1 отклоняется, потому что swagger minimum=0.',
    'offset=-1 отклонен non-2xx ответом.',
    'Passed',
  ],
  [
    'GET /v1/payout-platform/provider-job/get-status',
    'JOB-STATUS-001: get status for live job_uuid',
    'Для live job_uuid endpoint возвращает meta/result и payload содержит этот job_uuid.',
    'Для live job_uuid ответ успешный; payload содержит ожидаемый job_uuid.',
    'Passed',
  ],
  [
    'GET /v1/payout-platform/provider-job/get-status',
    'JOB-STATUS-NEG-001: missing job_uuid',
    'Запрос без обязательного job_uuid отклоняется.',
    'Запрос без job_uuid отклонен non-2xx ответом.',
    'Passed',
  ],
  [
    'GET /v1/payout-platform/provider-job/get-status',
    'JOB-STATUS-NEG-002: malformed job_uuid',
    'Malformed job_uuid отклоняется.',
    'job_uuid=not-a-uuid отклонен non-2xx ответом.',
    'Passed',
  ],
  [
    'GET /v1/payout-platform/provider-job/get-status',
    'JOB-STATUS-NEG-003: non-existent job_uuid',
    'Синтаксически валидный, но несуществующий job_uuid отклоняется.',
    '00000000-0000-4000-8000-000000000000 отклонен non-2xx ответом.',
    'Passed',
  ],
];

const workbook = Workbook.create();
const sheet = workbook.worksheets.add('Provider Jobs');
sheet.showGridLines = false;

sheet.getRange('A1:E1').values = [['Контракт', 'Проверка', 'Expected', 'Actual', 'Результат']];
sheet.getRange('A1:E1').format = {
  fill: '#1F4E78',
  font: { bold: true, color: '#FFFFFF' },
  wrapText: true,
};
sheet.getRangeByIndexes(1, 0, rows.length, 5).values = rows;
sheet.getRangeByIndexes(0, 0, rows.length + 1, 5).format.wrapText = true;
sheet.getRange('A:A').format.columnWidthPx = 310;
sheet.getRange('B:B').format.columnWidthPx = 330;
sheet.getRange('C:C').format.columnWidthPx = 390;
sheet.getRange('D:D').format.columnWidthPx = 390;
sheet.getRange('E:E').format.columnWidthPx = 95;
sheet.freezePanes.freezeRows(1);

for (let row = 2; row <= rows.length + 1; row += 1) {
  sheet.getRange(`E${row}`).format = {
    font: { bold: true, color: '#006100' },
  };
}

await fs.mkdir(outputDir, { recursive: true });
const preview = await workbook.render({ sheetName: 'Provider Jobs', autoCrop: 'all', scale: 1, format: 'png' });
await fs.writeFile(path.join(outputDir, 'provider-jobs-preview.png'), new Uint8Array(await preview.arrayBuffer()));

const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(outputPath);
console.log(outputPath);
