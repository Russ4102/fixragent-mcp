# Runs the stdio server for directories that build and inspect MCP servers (Glama).
# server.js has no runtime dependencies, so nothing is installed.
# No key is needed: tools/list answers offline; tools/call forwards to https://fixragent.com/mcp, with FIXRAGENT_API_KEY
# sent as x-triage-key when it is set. Glama: build steps [], CMD ["mcp-proxy", "--", "node", "server.js"].
FROM node:20-alpine
WORKDIR /app
COPY server.js ./
ENTRYPOINT ["node", "server.js"]
