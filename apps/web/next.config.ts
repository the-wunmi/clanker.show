import type { NextConfig } from "next";

const stationUrl = process.env.STATION_URL || "http://localhost:3001";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${stationUrl}/api/:path*`,
      },
    ];
  },
  allowedDevOrigins: ['192.168.0.166'],
};

export default nextConfig;
