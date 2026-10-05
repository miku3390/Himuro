import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 是原生模块，必须让 Next 原样 require 而不是打包
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
