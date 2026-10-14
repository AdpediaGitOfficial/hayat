/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Self-contained server bundle for the container image (see Dockerfile).
  output: 'standalone',
  poweredByHeader: false,
  // No image optimiser endpoint: unused in this app and the source of several Next 14 advisories (see README).
  images: { unoptimized: true },
  eslint: { dirs: ['app', 'src', 'tests', 'scripts'] },
}
export default nextConfig
