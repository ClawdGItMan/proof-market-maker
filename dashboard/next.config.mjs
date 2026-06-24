/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The dashboard holds no build-time secrets. Server-only env (DASHBOARD_CONTROL_SECRET,
  // and the edge-function URL) is read at request time inside server actions / route handlers
  // and must NEVER be inlined into the client bundle, so it is intentionally not listed here.
};

export default nextConfig;
