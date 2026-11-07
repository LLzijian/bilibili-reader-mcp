import { EventEmitter } from "node:events";
import https from "node:https";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDouyinHttp, MAX_DOUYIN_HTML_BYTES } from "../src/douyin/http.js";
import { createPinnedHttpsFetch, type AddressResolver } from "../src/security/pinned-https.js";
import { DOUYIN_ID, routerHtml } from "./fixtures/douyin.js";

type Reply = { status?: number; headers?: Record<string, string>; body?: string; hang?: boolean };
function transport(replies: Reply[]) {
  const captured: { url: URL; options: https.RequestOptions }[] = [];
  const request = vi.fn(((url: URL, options: https.RequestOptions, callback: (incoming: PassThrough) => void) => {
    captured.push({ url, options });
    const reply = replies[Math.min(captured.length - 1, replies.length - 1)] ?? {};
    const request = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void };
    let incoming: PassThrough;
    request.destroy = (error) => { incoming?.destroy(); if (error) queueMicrotask(() => request.emit("error", error)); };
    request.end = () => {
      if (reply.hang) return;
      queueMicrotask(() => {
        incoming = Object.assign(new PassThrough(), { statusCode: reply.status ?? 200, statusMessage: "Synthetic", headers: reply.headers ?? {} });
        callback(incoming);
        incoming.end(reply.body ?? ((reply.status ?? 200) === 200 && !reply.headers?.["content-length"] ? "synthetic media" : ""));
      });
    };
    return request;
  }) as unknown as typeof https.request);
  return { request, captured };
}
const publicResolver: AddressResolver = async () => [{ address: "8.8.8.8", family: 4 }];
afterEach(() => vi.unstubAllEnvs());

describe("Douyin pinned page and CDN transport", () => {
  it("rechecks page host, DNS and TLS identity on redirects", async () => {
    const mock = transport([{ status: 302, headers: { location: `https://www.iesdouyin.com/share/video/${DOUYIN_ID}/` } }, { body: routerHtml() }]);
    const resolver = vi.fn(publicResolver);
    const page = await createDouyinHttp({ ...mock, resolver }).fetchPage("https://v.douyin.com/fixture/");
    expect(page.url.hostname).toBe("www.iesdouyin.com");
    expect(resolver.mock.calls.map(([hostname]) => hostname)).toEqual(["v.douyin.com", "www.iesdouyin.com"]);
    expect(mock.captured.map(({ options }) => options.servername)).toEqual(["v.douyin.com", "www.iesdouyin.com"]);
    const lookup = mock.captured[1].options.lookup!;
    await new Promise<void>((resolve) => lookup("www.iesdouyin.com", {}, (error, address, family) => {
      expect(error).toBeNull(); expect(address).toBe("8.8.8.8"); expect(family).toBe(4); resolve();
    }));
  });
  it("allows five redirects and refuses a sixth", async () => {
    const redirect = { status: 302, headers: { location: "/again/" } };
    const allowed = transport([...Array(5).fill(redirect), { body: routerHtml() }]);
    await expect(createDouyinHttp({ ...allowed, resolver: publicResolver }).fetchPage("https://v.douyin.com/fixture/")).resolves.toHaveProperty("html");
    const denied = transport([redirect]);
    await expect(createDouyinHttp({ ...denied, resolver: publicResolver }).fetchPage("https://v.douyin.com/fixture/")).rejects.toMatchObject({ code: "PLATFORM_RESOLVE_FAILED" });
    expect(denied.request).toHaveBeenCalledTimes(6);
  });
  it.each(["https://localhost/video/1", "https://127.0.0.1/video/1", "https://www.douyin.com.evil.com/video/1", "http://www.douyin.com/video/1", "https://user@www.douyin.com/video/1", "https://www.douyin.com:444/video/1"])("refuses redirect %s before network", async (location) => {
    const mock = transport([{ status: 302, headers: { location } }]);
    await expect(createDouyinHttp({ ...mock, resolver: publicResolver }).fetchPage("https://v.douyin.com/fixture/")).rejects.toHaveProperty("code");
    expect(mock.request).toHaveBeenCalledOnce();
  });
  it.each(["127.0.0.1", "10.1.2.3", "169.254.1.1", "198.18.0.1"])("refuses a redirected approved hostname resolving to %s", async (address) => {
    const mock = transport([{ status: 302, headers: { location: `https://www.iesdouyin.com/share/video/${DOUYIN_ID}/` } }]);
    const resolver: AddressResolver = async (hostname) => [{ address: hostname === "v.douyin.com" ? "8.8.8.8" : address, family: 4 }];
    await expect(createDouyinHttp({ ...mock, resolver }).fetchPage("https://v.douyin.com/fixture/")).rejects.toMatchObject({ code: "PLATFORM_RESOLVE_FAILED" });
    expect(mock.request).toHaveBeenCalledOnce();
  });
  it("does not read local Cookie or forward any credential/header to CDN", async () => {
    vi.stubEnv("DOUYIN_COOKIE", "fixture-only-marker");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const mock = transport([{ status: 302, headers: { location: "https://backup.douyinvod.com/a.mp4" } }, {}]);
      const response = await createDouyinHttp({ ...mock, resolver: publicResolver }).mediaFetch(new Request("https://fixture.douyinvod.com/a.mp4", {
        headers: { Cookie: "fixture-only-marker", Authorization: "fixture-only-marker", "Proxy-Authorization": "fixture-only-marker", Host: "evil.com", "X-Forwarded-For": "127.0.0.1" },
      }));
      await response.text();
      for (const { options } of mock.captured) {
        expect(options.headers).not.toHaveProperty("cookie");
        expect(options.headers).not.toHaveProperty("authorization");
        expect(options.headers).not.toHaveProperty("proxy-authorization");
        expect(options.headers).not.toHaveProperty("host");
        expect(options.headers).not.toHaveProperty("x-forwarded-for");
      }
      expect(log).not.toHaveBeenCalled();
      const pageMock = transport([{ body: routerHtml() }]);
      await createDouyinHttp({ ...pageMock, resolver: publicResolver }).fetchPage(`https://www.douyin.com/video/${DOUYIN_ID}`);
      expect(pageMock.captured[0].options.headers).not.toHaveProperty("cookie");
    } finally { log.mockRestore(); }
  });
  it("refuses page and private-IP CDN redirects", async () => {
    const mock = transport([{ status: 302, headers: { location: "https://www.douyin.com/video/1" } }]);
    await expect(createDouyinHttp({ ...mock, resolver: publicResolver }).mediaFetch("https://fixture.douyinvod.com/a.mp4")).rejects.toMatchObject({ code: "DOUYIN_MEDIA_UNAVAILABLE" });
    const privateMock = transport([{ status: 302, headers: { location: "https://backup.douyinvod.com/a.mp4" } }]);
    await expect(createDouyinHttp({ ...privateMock, resolver: async (host) => [{ address: host.startsWith("backup") ? "10.0.0.1" : "8.8.8.8", family: 4 }] }).mediaFetch("https://fixture.douyinvod.com/a.mp4")).rejects.toThrow("public addresses");
    expect(privateMock.request).toHaveBeenCalledOnce();
  });
  it("rejects oversized bodies and structured HTTP denials", async () => {
    const huge = transport([{ headers: { "content-length": String(MAX_DOUYIN_HTML_BYTES + 1) } }]);
    await expect(createDouyinHttp({ ...huge, resolver: publicResolver }).fetchPage("https://v.douyin.com/fixture/")).rejects.toMatchObject({ code: "PLATFORM_RESOLVE_FAILED" });
    const denied = transport([{ status: 403 }]);
    await expect(createDouyinHttp({ ...denied, resolver: publicResolver }).fetchPage("https://v.douyin.com/fixture/")).rejects.toMatchObject({ code: "DOUYIN_ACCESS_DENIED" });
  });
  it("does not leak unsupported redirects to an outer downloader", async () => {
    const mock = transport([{ status: 300, headers: { location: "https://fixture.douyinvod.com/next" } }]);
    await expect(createDouyinHttp({ ...mock, resolver: publicResolver }).mediaFetch("https://fixture.douyinvod.com/a.mp4")).rejects.toMatchObject({ code: "PLATFORM_RESOLVE_FAILED" });
    expect(mock.request).toHaveBeenCalledOnce();
  });
  it("requires GET and isolates Douyin system DNS from Bilibili DoH configuration", async () => {
    const mock = transport([{}, { body: "<html></html>" }]);
    const resolver = vi.fn(publicResolver);
    const http = createDouyinHttp({ ...mock, resolver });
    await expect(http.mediaFetch("https://fixture.douyinvod.com/a", { method: "POST" })).rejects.toHaveProperty("code");
    expect(mock.request).not.toHaveBeenCalled();
    vi.stubEnv("BILIBILI_MEDIA_DNS", "cloudflare");
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const media = await http.mediaFetch("https://fixture.douyinvod.com/a");
    await media.arrayBuffer();
    await http.fetchPage("https://www.douyin.com/video/7123456789012345678");
    expect(resolver).toHaveBeenCalledWith("fixture.douyinvod.com");
    expect(resolver).toHaveBeenCalledWith("www.douyin.com");
    expect(mock.request).toHaveBeenCalledTimes(2);
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });
  it("honors caller cancellation before and during dispatch", async () => {
    const mock = transport([{ hang: true }]);
    const controller = new AbortController();
    const http = createDouyinHttp({ ...mock, resolver: publicResolver });
    await expect(http.mediaFetch("https://fixture.douyinvod.com/a", { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    const pending = http.mediaFetch("https://fixture.douyinvod.com/a", { signal: controller.signal });
    // DNS resolution and dispatch settle in microtasks; cancel once dispatched.
    await vi.waitFor(() => expect(mock.request).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
  it("isolates the new factory policy from the Bilibili allowlist", async () => {
    const fetchFn = createPinnedHttpsFetch({ allowedHostSuffixes: [".douyinvod.com"] });
    await expect(fetchFn("https://cdn.bilivideo.com/a", {}, { resolver: publicResolver })).rejects.toThrow("approved media URL");
    expect(() => createPinnedHttpsFetch({ allowedHostSuffixes: ["douyinvod.com"] })).toThrow(TypeError);
  });
});
