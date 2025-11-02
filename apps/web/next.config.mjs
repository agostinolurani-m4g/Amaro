/** @type {import('next').NextConfig} */
const isProd = process.env.NODE_ENV === 'production';
const repo = process.env.NEXT_PUBLIC_REPO || '';
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  basePath: isProd && repo ? `/${repo}` : '',
  assetPrefix: isProd && repo ? `/${repo}/` : '',
};
export default nextConfig;
