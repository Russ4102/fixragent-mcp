# Runs the stdio server for directories that build and inspect MCP servers (Glama).
# server.js has no runtime dependencies, so nothing is installed.
# The key is optional at start: tools/list answers without it; triage_photo needs FIXRAGENT_API_KEY.
FROM node:20-alpine
WORKDIR /app
COPY server.js ./
ENTRYPOINT ["node", "server.js"]
