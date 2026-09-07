const { spawnSync } = require('node:child_process');

const [, , envName, ...playwrightArgs] = process.argv;

const supportedEnvs = ['dev', 'test', 'stage'];

if (!envName || !supportedEnvs.includes(envName)) {
  console.error(`Usage: node scripts/run-tests.js <${supportedEnvs.join('|')}> [playwright args...]`);
  process.exit(1);
}

const result = spawnSync('npx', ['playwright', 'test', ...playwrightArgs], {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    PLATFORM_ENV: envName,
    PLAYWRIGHT_HEADED: playwrightArgs.includes('--headed') ? 'true' : process.env.PLAYWRIGHT_HEADED,
  },
});

process.exit(result.status ?? 1);
