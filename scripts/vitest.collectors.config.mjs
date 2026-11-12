const config = {
  test: {
    environment: "node",
    include: [
      "scripts/__tests__/kimi-zcode-telemetry.test.mjs",
      "scripts/__tests__/transfer-muse-code-access-token-to-infisical.test.mjs",
    ],
  },
};

export default config;
