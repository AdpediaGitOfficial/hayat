/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // No image optimiser endpoint: unused in this app and the source of several Next 14 advisories (see README).
  images: { unoptimized: true },
  // Native addon (Argon2id): loaded from node_modules at runtime, not bundled.
  experimental: { serverComponentsExternalPackages: ['@node-rs/argon2', 'pg'] },
  eslint: { dirs: ['app', 'src', 'tests', 'scripts'] },
}
export default nextConfig
