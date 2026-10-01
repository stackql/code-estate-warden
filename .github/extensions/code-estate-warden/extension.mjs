// code-estate-warden as a Copilot CLI extension: the tools and hook from src/extension.ts, joined to the
// session the person is typing in. The CLI forks this file when it starts in this repository.
// Extensions must be .mjs, so this stays a thin shim over the TypeScript modules.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";
import { loadConfig } from "../../../src/config.ts";
import { extensionTool, extensionTools, hooksFor, newState, tokensToRequest } from "../../../src/extension.ts";

// runs/, code-estate-warden.toml and .env are relative to the repository root
process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
if (existsSync(".env")) process.loadEnvFile(".env");

const config = loadConfig("code-estate-warden.toml");
let session;
const log = (line) => void session?.log(line, { ephemeral: true }).catch(() => {});
const tools = extensionTools(config, newState(), log).map(extensionTool);
const hooks = hooksFor(tools.map((t) => t.name));

session = await joinSession({ tools, hooks, requestedEnvironmentVariables: tokensToRequest() });
await session.log(`code-estate-warden: ${tools.length} tools, orgs ${config.orgs.join(", ")}`);
