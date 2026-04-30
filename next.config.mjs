/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { serverActions: { bodySizeLimit: "10mb" } },
  // pdf-parse pulls in pdfjs-dist which webpack mangles into a broken module
  // ("Object.defineProperty called on non-object"). Force Next to treat it as
  // an external require() at runtime instead of bundling it.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
};
export default nextConfig;
