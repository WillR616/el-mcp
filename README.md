# el-mcp

Two sentences about Danish household electricity.

**Past:** Last year you could have saved DKK X by moving usage from [these hours] to [those hours].

**Now:** For the rest of today (and tomorrow after ~13:00) you can save DKK Y by pushing usage from 19:00 back to 22:00.

Hourly import and grid charges come from [Eloverblik](https://eloverblik.dk). Spot comes from Energi Data Service. One user, self-hosted, read-only.

## Setup

1. Node 24+.
2. In Eloverblik: **Profil → Datadeling → Opret token**. Put the refresh token in `~/.el-mcp`:

```
ELOVERBLIK_REFRESH_TOKEN=eyJ...
```

or in `.env` as the same key. Never commit it.

3. Cursor / Claude stdio:

```json
{ "mcpServers": { "el": { "command": "node", "args": ["--env-file-if-exists=.env", "src/stdio.ts"], "cwd": "/Users/you/dev/side/el-mcp" } } }
```

Ask for the two sentences. `setup` checks the token; `pick_meter` chooses the import meter.

Optional: `EL_MCP_MARKUP` (default `0.08` DKK/kWh excl. VAT), `EL_MCP_MOVE_FRACTION` (default `0.4` of the expensive-hour spike).
