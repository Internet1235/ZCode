import {
  createLocalServices,
  disposeServiceResourcesAndWait,
  getAppConfigDir,
} from "@zcode/services/node";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import { closeHttpServer, createHttpServer } from "./http.js";

async function assertWebStaticRoot(staticRoot: string): Promise<void> {
  const indexFile = resolve(staticRoot, "index.html");
  const indexStat = await stat(indexFile).catch(() => null);
  if (!indexStat?.isFile()) {
    throw new Error(`Missing web index: ${indexFile}`);
  }

  const html = await readFile(indexFile, "utf8");
  const assetReferences = [...html.matchAll(/(?:src|href)=["'](?:\/|\.\/)(assets\/[^"']+)["']/g)]
    .map((match) => (match[1] ? `/${match[1]}` : undefined))
    .filter((assetPath): assetPath is string => typeof assetPath === "string");
  if (assetReferences.length === 0) {
    throw new Error(`Web index has no generated asset references: ${indexFile}`);
  }

  for (const assetPath of assetReferences) {
    const assetFile = resolve(staticRoot, `.${assetPath}`);
    const assetStat = await stat(assetFile).catch(() => null);
    if (!assetStat?.isFile()) {
      throw new Error(`Missing web asset ${assetPath}: ${assetFile}`);
    }
  }
}

async function resolveStaticRoot(): Promise<string | undefined> {
  const configured = process.env["ZCODE_WEB_STATIC_ROOT"]?.trim();
  if (configured) {
    await assertWebStaticRoot(configured);
    return configured;
  }

  const packagedWebRoot = resolve(fileURLToPath(new URL("../web", import.meta.url)));
  const packagedIndex = await stat(resolve(packagedWebRoot, "index.html")).catch(() => null);
  if (!packagedIndex?.isFile()) {
    return undefined;
  }
  await assertWebStaticRoot(packagedWebRoot);
  return packagedWebRoot;
}

async function main(): Promise<void> {
  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  const port = Number(process.env["PORT"]) || 3030;
  const host = process.env["ZCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const socketPath = process.env["ZCODE_SERVER_SOCKET"]?.trim() || undefined;
  const staticRoot = await resolveStaticRoot();
  const authToken = process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: Boolean(authToken),
  });

  const server = await createHttpServer(services, port, {
    ...(host ? { host } : {}),
    ...(socketPath ? { socketPath } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    let shutdownError: unknown;
    try {
      await closeHttpServer(server);
    } catch (error: unknown) {
      console.error(`[zcode-server:http] shutdown failed after ${signal}`, error);
      shutdownError = error;
    }
    try {
      await disposeServiceResourcesAndWait(services);
    } catch (error: unknown) {
      console.error(`[zcode-server:http] service cleanup failed after ${signal}`, error);
      shutdownError ??= error;
    }
    if (shutdownError) {
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
