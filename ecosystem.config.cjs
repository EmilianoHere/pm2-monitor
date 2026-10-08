// PM2 ecosystem file for running the monitor itself under PM2.
//
//   npm run build                      # produces dist/index.js
//   pm2 start ecosystem.config.cjs     # start the monitor under PM2
//
// Note: this project is an ES module ("type":"module" in package.json), so the
// ecosystem file uses the .cjs extension — PM2 loads ecosystem configs through
// CommonJS `require`, which cannot evaluate `module.exports` in a file parsed as
// ESM. The .cjs extension forces CommonJS so `module.exports` works.
//
// Prefer putting real secrets in a `.env` file (loaded by dotenv at boot)
// rather than inlining them here. The `env` block below documents the vars the
// app reads and sets a few safe defaults; anything left out falls back to the
// defaults in src/config/env.ts. See .env.example for the full reference.

module.exports = {
  apps: [
    {
      name: 'pm2-monitor',
      script: 'dist/index.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',

        // HTTP + WebSocket server
        PORT: 3000,
        HOST: '127.0.0.1',

        // Authentication (apikey mode by default; set a real key in .env)
        AUTH_MODE: 'apikey',
        // API_KEY: 'set-in-dotenv',
        // BASIC_USER: 'admin',
        // BASIC_PASS: 'set-in-dotenv',

        // Email (SMTP) channel — leave unset to disable
        // SMTP_HOST: 'smtp.example.com',
        // SMTP_PORT: 587,
        // SMTP_SECURE: 'false',
        // SMTP_USER: 'alerts@example.com',
        // SMTP_PASS: 'set-in-dotenv',
        // MAIL_FROM: 'alerts@example.com',
        // MAIL_TO: 'oncall@example.com',

        // Microsoft Teams channel — leave unset to disable
        // TEAMS_WEBHOOK_URL: 'set-in-dotenv',

        // Alert rules
        ALERT_RULES_FILE: 'config/alert-rules.json',

        // Metrics
        METRICS_RETENTION_MIN: 180,
        METRICS_SAMPLE_SEC: 5,

        // Error capture
        ERROR_BUFFER_SIZE: 500,
        ERROR_LOG_APPEND: 'false',

        // Alerting behavior
        DEFAULT_COOLDOWN_SEC: 300,
        INTENTIONAL_ACTION_GRACE_MS: 10000,
        // ALLOWED_SCRIPT_ROOT: '',

        // Daily digest (email-only)
        DIGEST_ENABLED: 'false',
        DIGEST_HOUR: 8,

        // Logging
        LOG_LEVEL: 'info',
      },
    },
  ],
};
