import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Proxy API requests to station server in dev
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:3001/api/:path*",
      },
    ];
  },
};

export default nextConfig;
