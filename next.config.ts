import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This non-secret compile-time switch is enabled only in the isolated
  // renderer image; public web builds keep it disabled.
  env: {
    AMUHON_PDF_RENDERER_INTERNAL_MODE: process.env.AMUHON_PDF_RENDERER_INTERNAL_MODE === "true" ? "true" : "false",
  },
};

export default nextConfig;
