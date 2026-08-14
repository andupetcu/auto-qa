// PM2 process file — v0.1 dev stack (no docker).
// Start: pm2 start ecosystem.config.js
// The control plane serves REST (/api/v1), MCP (/mcp) and signed artifact URLs on QA_CP_PORT.
module.exports = {
  apps: [
    {
      name: 'qa-control-plane',
      cwd: __dirname,
      script: 'control-plane/.venv/bin/uvicorn',
      args: 'app.main:app --host 127.0.0.1 --port 8787 --app-dir control-plane',
      interpreter: 'none',
      env: { PYTHONUNBUFFERED: '1' },
      max_restarts: 10,
      out_file: 'var/logs/control-plane.out.log',
      error_file: 'var/logs/control-plane.err.log',
    },
  ],
};
