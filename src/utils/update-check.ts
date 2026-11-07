import fs from "fs";
import { fileURLToPath } from "node:url";
import { SECURITY_LIMITS } from "../security/limits.js";
import {
  createAbortError,
  getOperationSignal,
  linkAbortSignal,
  throwIfAborted,
} from "../security/operation-context.js";
import { parseBoundedJsonResponse } from "./bounded-response.js";
import { ResourceLimitError } from "./errors.js";

const PACKAGE_NAME = "@llzijian/video-reader-mcp";
const LOCAL_ENTRY = fileURLToPath(new URL("../index.js", import.meta.url));
const LOCAL_CLI = fileURLToPath(new URL("../cli.js", import.meta.url));
const NPM_LATEST_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`;
const UPDATE_TIMEOUT_MS = 5_000;
const UPDATE_CACHE_MS = 5 * 60 * 1_000;

type FetchLike = typeof fetch;
let cachedUpdate:
  | { expiresAt: number; value: PackageUpdateInfo }
  | undefined;
let inFlightUpdate: Promise<PackageUpdateInfo> | null = null;
let activeUpdateWaiters = 0;

export interface PackageUpdateInfo {
  package_name: typeof PACKAGE_NAME;
  current_version: string;
  latest_version: string | null;
  update_available: boolean | null;
  checked_registry: string;
  recommended_mcp_config: {
    command: "node";
    args: string[];
  };
  update_commands: {
    npx_config: string;
    npx_check: string;
    global_update: string;
  };
  notes: string[];
  notes_en: string[];
  notes_zh: string[];
}

function readCurrentVersion(): string {
  const packageJsonUrl = new URL("../../package.json", import.meta.url);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonUrl, "utf8")) as {
    version?: unknown;
  };

  if (typeof packageJson.version !== "string") {
    throw new Error("package.json version is missing");
  }

  return packageJson.version;
}

function parseVersion(version: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) return null;
  return match.slice(1).map(Number);
}

function isNewerVersion(latestVersion: string, currentVersion: string): boolean | null {
  const latest = parseVersion(latestVersion);
  const current = parseVersion(currentVersion);
  if (!latest || !current) return null;

  for (let index = 0; index < latest.length; index += 1) {
    if (latest[index] > current[index]) return true;
    if (latest[index] < current[index]) return false;
  }

  return false;
}

function buildBaseInfo(currentVersion: string): Omit<
  PackageUpdateInfo,
  "latest_version" | "update_available"
> {
  const notesEn = [
    "This fork runs from source; no npm package is published yet. Use the local Node entry point.",
    "Restart or reload the MCP client after changing package versions or MCP configuration.",
    "Do not print update hints during stdio startup; stdout must stay reserved for JSON-RPC.",
  ];
  const notesZh = [
    "当前 fork 从源码运行，尚未发布 npm 包；请使用本机 Node 入口。",
    "修改包版本或 MCP 配置后，请重启或重新加载 MCP 客户端。",
    "不要在 stdio 启动时打印更新提示；stdout 必须保留给 JSON-RPC。",
  ];

  return {
    package_name: PACKAGE_NAME,
    current_version: currentVersion,
    checked_registry: NPM_LATEST_URL,
    recommended_mcp_config: {
      command: "node",
      args: [LOCAL_ENTRY],
    },
    update_commands: {
      npx_config: `node "${LOCAL_CLI}" config`,
      npx_check: `node "${LOCAL_CLI}" check`,
      global_update: "Update your Git source checkout, then run npm ci and npm run build.",
    },
    notes: notesEn,
    notes_en: notesEn,
    notes_zh: notesZh,
  };
}

async function fetchPackageUpdateInfo(
  fetchImpl: FetchLike,
  callerSignal?: AbortSignal,
): Promise<PackageUpdateInfo> {
  throwIfAborted(callerSignal);
  const currentVersion = readCurrentVersion();
  const baseInfo = buildBaseInfo(currentVersion);
  const controller = new AbortController();
  const unlinkAbort = linkAbortSignal(callerSignal, controller);
  const timer = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);

  try {
    const response = await fetchImpl(NPM_LATEST_URL, {
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });

    if (response.status === 404) {
      return {
        ...baseInfo,
        latest_version: null,
        update_available: null,
        notes: [...baseInfo.notes, "This package is not published on npm; update the source checkout."],
        notes_en: [...baseInfo.notes_en, "This package is not published on npm; update the source checkout."],
        notes_zh: [...baseInfo.notes_zh, "此包尚未发布到 npm；请更新源码工作区。"],
      };
    }

    if (!response.ok) {
      throw new Error(`npm registry returned HTTP ${response.status}`);
    }

    const payload = await parseBoundedJsonResponse<{ version?: unknown }>(
      response,
      SECURITY_LIMITS.updateCheckBytes,
      "npm_update_json",
    );
    const latestVersion =
      typeof payload.version === "string" &&
      payload.version.length <= 64 &&
      parseVersion(payload.version) !== null
        ? payload.version
        : null;

    return {
      ...baseInfo,
      latest_version: latestVersion,
      update_available:
        latestVersion === null ? null : isNewerVersion(latestVersion, currentVersion),
    };
  } catch {
    if (callerSignal?.aborted) {
      throw createAbortError();
    }
    return {
      ...baseInfo,
      latest_version: null,
      update_available: null,
      notes: [
        ...baseInfo.notes,
        "Could not reach the npm registry; retry later or run npm view @llzijian/video-reader-mcp version.",
      ],
      notes_en: [
        ...baseInfo.notes_en,
        "Could not reach the npm registry; retry later or run npm view @llzijian/video-reader-mcp version.",
      ],
      notes_zh: [
        ...baseInfo.notes_zh,
        "无法连接 npm registry；请稍后重试，或运行 npm view @llzijian/video-reader-mcp version。",
      ],
    };
  } finally {
    clearTimeout(timer);
    unlinkAbort();
    controller.abort();
  }
}

function waitForCaller<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function waitForSharedUpdate(
  promise: Promise<PackageUpdateInfo>,
  signal?: AbortSignal,
): Promise<PackageUpdateInfo> {
  throwIfAborted(signal);
  if (activeUpdateWaiters >= SECURITY_LIMITS.updateCheckWaiters) {
    throw new ResourceLimitError(
      "Package update check waiter capacity is full",
      "update_check_waiters",
      SECURITY_LIMITS.updateCheckWaiters,
    );
  }
  activeUpdateWaiters += 1;
  try {
    return await waitForCaller(promise, signal);
  } finally {
    activeUpdateWaiters -= 1;
  }
}

export async function buildPackageUpdateInfo(
  fetchImpl: FetchLike = globalThis.fetch,
  signal?: AbortSignal,
): Promise<PackageUpdateInfo> {
  const operationSignal = getOperationSignal(signal);
  throwIfAborted(operationSignal);
  const useSharedState = fetchImpl === globalThis.fetch;
  if (!useSharedState) {
    return await waitForCaller(
      fetchPackageUpdateInfo(fetchImpl, operationSignal),
      operationSignal,
    );
  }

  if (cachedUpdate && cachedUpdate.expiresAt > Date.now()) {
    return cachedUpdate.value;
  }
  if (!inFlightUpdate) {
    // The underlying single-flight is process-owned. Cancelling one caller
    // releases only that waiter and must not abort work still needed by others.
    inFlightUpdate = fetchPackageUpdateInfo(fetchImpl)
      .then((value) => {
        cachedUpdate = {
          expiresAt: Date.now() + UPDATE_CACHE_MS,
          value,
        };
        return value;
      })
      .finally(() => {
        inFlightUpdate = null;
      });
  }
  return await waitForSharedUpdate(inFlightUpdate, operationSignal);
}
