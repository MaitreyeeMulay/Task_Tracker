import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Next.js 16 writes an AGENTS.md into the repo on every `next dev`; this repo has its own rules file.
  agentRules: false,
};

export default nextConfig;
