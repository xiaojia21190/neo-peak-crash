import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 允许外部资源（收敛到白名单）
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'connect.linux.do',
      },
      {
        protocol: 'https',
        hostname: 'cdn.linux.do',
      },
      {
        protocol: 'https',
        hostname: '*.linux.do',
      },
    ],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
