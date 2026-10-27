import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  // Self-contained server bundle for the Docker image.
  output: "standalone",
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@launchpad/db", "@launchpad/par-client", "@launchpad/theme"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Embedded on customer sites; short cache so widget fixes roll out quickly.
        source: "/arag-chat.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300" },
          { key: "Access-Control-Allow-Origin", value: "*" },
        ],
      },
    ];
  },
};

export default config;
