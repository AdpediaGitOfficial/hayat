// PM2 process file for the platform. Both processes read their settings from /etc/gh-platform.env (Node 22 --env-file).
// Start:   pm2 start deploy/ecosystem.config.cjs      Save + boot:   pm2 save && pm2 startup
const ENV_FILE = process.env.GH_ENV_FILE || '/etc/gh-platform.env'
const cwd = '/opt/gh-platform/platform'
module.exports = {
  apps: [
    {
      name: 'gh-platform',
      cwd,
      script: 'node_modules/next/dist/bin/next',
      args: 'start',
      node_args: `--env-file=${ENV_FILE}`,
      autorestart: true,
      max_memory_restart: '1G',
    },
    {
      // Reminders and escalations. They never approve, reject or move anyone. Needs to run, or nothing escalates.
      name: 'gh-sweeps',
      cwd,
      script: 'node_modules/tsx/dist/cli.mjs',
      args: 'scripts/sweeps.ts --loop 60',
      node_args: `--env-file=${ENV_FILE}`,
      autorestart: true,
      restart_delay: 10000,
    },
  ],
}
