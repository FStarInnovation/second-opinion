import type { NextConfig } from "next";

const config: NextConfig = {
  // Движок и блоки — исходники TypeScript из workspaces, Next транспилирует их сам
  transpilePackages: ["@so/engine", "@so/blocks"],
  // Снимки ISS и golden нужны движку в офлайн-режиме (SO_OFFLINE=1): не вырезать из серверного бандла
  outputFileTracingIncludes: { "/*": ["../../packages/engine/golden/**/*"] },
  // Next 16 сам пишет apps/web/AGENTS.md при каждом dev-запуске — нам он не нужен
  agentRules: false,
};

export default config;
