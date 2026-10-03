import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The simulation packages ship TypeScript sources rather than a build step:
  // one less thing to keep in sync, and Node tests and the browser read the
  // exact same files.
  transpilePackages: [
    '@distlab/shared',
    '@distlab/algorithms',
    '@distlab/ai',
    '@distlab/scenarios',
    '@distlab/network',
    '@distlab/telemetry',
    '@distlab/simulation-engine',
  ],
  webpack: (config) => {
    // The packages are ESM and import siblings as './thing.js'. On disk those
    // are .ts files, so webpack needs to be told the mapping that TypeScript's
    // bundler resolution already assumes.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default config;
