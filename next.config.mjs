/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: '1mb' },
  },
  serverExternalPackages: ['better-sqlite3'],
  // TypeScript ESM convention: relative imports carry the .js extension. tsx
  // and vitest auto-resolve those to the .ts source; webpack does not. Tell
  // it to try .ts/.tsx when it sees a .js import. Without this, Next dev
  // crashes on every "./foo.js" relative import.
  webpack(config) {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
