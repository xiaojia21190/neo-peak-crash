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
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Content-Security-Policy',
            // Security hardening: Removed 'unsafe-eval' and 'unsafe-inline' from script-src
            // to prevent XSS attacks. If inline scripts are needed, implement nonce-based CSP
            // using Next.js middleware: https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy
            value: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' wss: https:; font-src 'self' data:;"
          },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
