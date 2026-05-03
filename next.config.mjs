/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: '1mb' },
  },
  serverExternalPackages: ['better-sqlite3'],
};

export default nextConfig;
