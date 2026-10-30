FROM node:24.22.1-bookworm-slim
ARG INFISICAL_CLI_VERSION=0.43.114
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && arch="$(uname -m)" \
  && case "$arch" in aarch64|arm64) cli_arch=arm64 ;; x86_64|amd64) cli_arch=amd64 ;; *) exit 1 ;; esac \
  && curl -fsSL --http1.1 --retry 5 --retry-delay 2 --retry-all-errors -o /tmp/infisical.tgz \
    "https://github.com/Infisical/cli/releases/download/v${INFISICAL_CLI_VERSION}/cli_${INFISICAL_CLI_VERSION}_linux_${cli_arch}.tar.gz" \
  && tar -xzf /tmp/infisical.tgz -C /tmp \
  && install -m 0755 /tmp/infisical /usr/local/bin/infisical \
  && rm -rf /tmp/* \
  && infisical --version
WORKDIR /app
COPY deploy/telemetry-hub/package.json deploy/telemetry-hub/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY scripts/telemetry-hub ./scripts/telemetry-hub
COPY scripts/lib/fleet-secrets.mjs ./scripts/lib/fleet-secrets.mjs
RUN groupadd --gid 10001 telemetry \
  && useradd --uid 10001 --gid 10001 --home-dir /data --no-create-home --shell /usr/sbin/nologin telemetry \
  && mkdir /data && chown 10001:10001 /data
USER 10001:10001
ENV TELEMETRY_HUB_SENTRY_ONLY=1 TELEMETRY_HUB_METADATA_ONLY=1 TELEMETRY_HUB_READINESS_FILE=/tmp/telemetry-hub-ready.json
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "-e", "try{const a=JSON.parse(require('node:fs').readFileSync('/tmp/telemetry-hub-ready.json'));const s=require('node:net').connect(a.port,a.host);s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));s.setTimeout(3000,()=>process.exit(1));}catch{process.exit(1)}"]
CMD ["node", "scripts/telemetry-hub/start-with-infisical.mjs"]
