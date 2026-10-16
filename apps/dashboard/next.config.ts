import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  // npm workspaces hoist dependencies to the repository root; trace from there so the standalone
  // bundle (used by the Docker image) contains them.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  reactStrictMode: true,
  poweredByHeader: false,
  // Do not generate AGENTS.md / CLAUDE.md into the repository on `next dev`.
  agentRules: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default config;
