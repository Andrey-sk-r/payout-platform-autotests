const fs = require('node:fs');
const path = require('node:path');

// The invoice generator is kept outside this test repository so testers can
// regenerate documents without committing binary assets. CI must set
// INVOICE_FIXTURES_DIR; the local default preserves the existing Windows setup.
const DEFAULT_FIXTURES_DIR = 'C:\\Users\\Andrey\\Documents\\invoice generator\\output';

const fixturesDir = process.env.INVOICE_FIXTURES_DIR || DEFAULT_FIXTURES_DIR;
const negativeFixturesDir = process.env.INVOICE_NEGATIVE_FIXTURES_DIR
  || path.join(fixturesDir, 'negative_pack');

const fixtureNames = {
  validZar: 'INV-TEST-1789_BranchSource-Investec.png',
  validZarSecond: 'INV-TEST-2690_BranchSource-Discovery-Bank.png',
  usd: 'INV-TEST-4771_BranchSource-Nedbank.png',
  conflict: 'INV-TEST-9637_BranchSource-Capitec.csv',
  invalidPdf: 'NEG-corrupted_invoice.pdf',
  invalidXlsx: 'NEG-corrupted.xlsx',
  invalidTxt: 'NEG-invalid_utf8.txt',
  invalidCsv: 'NEG-invalid_utf8.csv',
  extensionMismatch: 'NEG-png_content_with_pdf_extension.pdf',
};

function requiredFile(directory, fileName, variableName) {
  const filePath = path.join(directory, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `${variableName || 'Invoice fixture'} is unavailable: ${filePath}. `
      + 'Set INVOICE_FIXTURES_DIR (and optionally INVOICE_NEGATIVE_FIXTURES_DIR) to the QA Invoice Generator output.',
    );
  }
  return filePath;
}

function invoiceFixture(name) {
  if (!Object.hasOwn(fixtureNames, name)) {
    throw new Error(`Unknown invoice fixture: ${name}`);
  }
  const isNegative = name.startsWith('invalid') || name === 'extensionMismatch';
  return requiredFile(isNegative ? negativeFixturesDir : fixturesDir, fixtureNames[name], `Invoice fixture "${name}"`);
}

function invoiceFormatFixtures() {
  const stem = process.env.INVOICE_VALID_FIXTURE_STEM || 'INV-TEST-1789_BranchSource-Investec';
  return ['.pdf', '.png', '.jpg', '.txt', '.csv', '.xlsx', '.xls']
    .map((extension) => requiredFile(fixturesDir, `${stem}${extension}`, `Valid ${extension} invoice fixture`));
}

function invalidParserFixtures() {
  return [
    invoiceFixture('invalidPdf'),
    invoiceFixture('invalidXlsx'),
    invoiceFixture('invalidTxt'),
    invoiceFixture('invalidCsv'),
  ];
}

function mimeTypeFor(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
  }[ext] || 'application/octet-stream';
}

function uniqueUpload(filePath, prefix, testInfo) {
  const ext = path.extname(filePath);
  const stamp = `${Date.now()}-${testInfo.parallelIndex}-${testInfo.retry}`;
  const name = `${prefix}-${stamp}${ext}`;
  return {
    name,
    mimeType: mimeTypeFor(name),
    buffer: fs.readFileSync(filePath),
  };
}

module.exports = {
  invoiceFixture,
  invoiceFormatFixtures,
  invalidParserFixtures,
  uniqueUpload,
};
