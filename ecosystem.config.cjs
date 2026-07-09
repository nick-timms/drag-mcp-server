// PM2 process file for the hosted MCP HTTP endpoint.
//   Build first:  npm ci && npm run build
//   Start:        pm2 start ecosystem.config.cjs
//   Save/boot:    pm2 save && pm2 startup
//
// The service is stateless, so it is safe to run in cluster mode across cores
// (set instances: "max", exec_mode: "cluster"). Fork mode with a single
// instance is the simplest starting point.
//
// Set secrets/hosts (DRAG_API_BASE, REDIS_*) via the box's own environment or
// secret manager rather than committing them here.
module.exports = {
  apps: [
    {
      name: "dragapp-mcp",
      script: "dist/http.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        MCP_PORT: 3001,
        MCP_PATH: "/mcp",
        // DRAG_API_BASE: "https://app.dragapp.com",  // or an internal VPC address
        // REDIS_HOST: "...",
        // REDIS_PORT: 6379,
        // REDIS_PASSWORD: "...",
        // MCP_RATE_LIMIT: 60,
        // MCP_RATE_WINDOW: 60,
        // MCP_RATE_LIMIT_FAIL_OPEN: "true",
      },
      max_restarts: 10,
      restart_delay: 2000,
      kill_timeout: 6000,
    },
  ],
};
