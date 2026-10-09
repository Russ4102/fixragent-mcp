# Installing the fixRAgent MCP server (for AI agents)

fixRAgent is maintenance triage for property managers, landlords and the companies that run buildings. Given one photo of something in a building (a leak, a water heater, a boiler, an electrical panel, an appliance, damage), it returns a Triage Profile: what the asset is, whether a fault is visible, how urgent it is in one of four words (EMERGENCY, TODAY, THIS WEEK, WHENEVER), which trade to call, and a line to say to the resident.

There are two ways to connect. **Use option 1** unless the client cannot reach a remote server.

## Option 1 (recommended): the remote server, nothing to install

- URL: `https://fixragent.com/mcp`
- Transport: streamable HTTP
- Tools: `try_sample`, `assess_property_photo`, `get_triage_profile`
- Key: optional. Without one, `try_sample` works and `assess_property_photo` reads up to 3 real photos per connection in a rolling 24 hours (shared across keyless callers up to a daily ceiling); past that it returns a stored SAMPLE result and says so. `get_triage_profile` needs a key. A free key is issued at https://fixragent.com/docs#key.

### Cline

Add this to `cline_mcp_settings.json` (Cline: MCP Servers, then Configure MCP Servers):

```json
{
  "mcpServers": {
    "fixragent": {
      "type": "streamableHttp",
      "url": "https://fixragent.com/mcp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

If the user has a key, add it as a header (never put the key in the URL or in a file that is committed):

```json
      "headers": { "x-triage-key": "THE_USER'S_KEY" }
```

### Other clients

- Claude Code: `claude mcp add --transport http fixragent https://fixragent.com/mcp`
- Claude, ChatGPT, Cursor, VS Code: add a custom connector (remote MCP server) with the URL `https://fixragent.com/mcp`. Steps for each: https://fixragent.com/connect-ai.html

### Check that it works

1. List the tools. Expect exactly `try_sample`, `assess_property_photo` and `get_triage_profile`.
2. Call `try_sample` with no arguments. It needs no key, reads no photo and spends nothing. The result is labelled SAMPLE: tell the user plainly that it is a sample and not their photo.

## Option 2: the local stdio server (`server.js`)

Use this only if the client cannot reach a remote server. It is an older one-file server with **one** tool, `triage_photo`, in front of `https://fixragent.com/api/triage`. It **needs a key** (`FIXRAGENT_API_KEY`). It is not published on npm; install it from this repository or from fixragent.com.

Requirements: Node 20 or newer. No runtime dependencies.

1. Get the file (either one):

   ```sh
   mkdir -p ~/fixragent-mcp
   curl -fsSL https://fixragent.com/mcp/server.js -o ~/fixragent-mcp/server.js
   ```

   or `git clone https://github.com/Russ4102/fixragent-mcp ~/fixragent-mcp`

2. Check it: `FIXRAGENT_API_KEY=THE_USER'S_KEY node ~/fixragent-mcp/server.js --check` prints whether the key is set and whether fixragent.com answers. It never prints the key.

3. Add it to `cline_mcp_settings.json`, with the absolute path to `server.js`:

   ```json
   {
     "mcpServers": {
       "fixragent": {
         "command": "node",
         "args": ["/absolute/path/to/fixragent-mcp/server.js"],
         "env": { "FIXRAGENT_API_KEY": "THE_USER'S_KEY" },
         "disabled": false,
         "autoApprove": []
       }
     }
   }
   ```

Optional environment variables:
- `FIXRAGENT_IMAGE_DIR`: the one folder `image_path` may read photos from. Unset, `image_path` is off and only `image_base64` works. Leave it unset unless the user names a folder.
- `FIXRAGENT_API_URL`: another API base, such as the mock described in the README. Default `https://fixragent.com`.

## Rules for the agent using these tools

- Anything happening right now that needs emergency services (fire, a gas smell, someone hurt) is a 911 call, not a tool call.
- The tools assess photos of building assets and faults only. They do not assess people, pets, injuries, vehicles, food or documents.
- They do not price repairs, book contractors or decide insurance claims.
- Start with `try_sample`; do not ask for a key up front. If the user gives a key, put it only where the user chose (the client settings), never in a committed file or in the URL.

More: https://fixragent.com/docs · https://fixragent.com/llms.txt · support@fixragent.com
