import { afterEach, describe, expect, it, vi } from "vitest";
import { queryPublicMediaDns, resolvePinnedAddress } from "../src/security/pinned-https.js";
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
const answer=(Answer: unknown, Status: unknown=0)=>vi.fn(async()=>new Response(JSON.stringify({Status,Answer}),{headers:{"content-type":"application/dns-json"}}));
describe("opt-in public media DNS",()=>{
 it("only sends the approved media hostname to a fixed HTTPS resolver",async()=>{
  const fetch=answer([{type:5,data:"canonical.example"},{type:1,data:"1.1.1.1"}]);
  expect(await queryPublicMediaDns("cdn.bilivideo.com",undefined,fetch)).toEqual([{address:"1.1.1.1",family:4}]);
  const [url,init]=fetch.mock.calls[0];expect(url.origin).toBe("https://cloudflare-dns.com");expect(url.searchParams.get("name")).toBe("cdn.bilivideo.com");
  expect(init).toMatchObject({redirect:"manual",credentials:"omit",headers:{Accept:"application/dns-json"}});
  expect(JSON.stringify(init)).not.toMatch(/Cookie|Authorization/);
 });
 it.each(["evil.test","cdn.bilivideo.com.evil.test","http://cdn.bilivideo.com"]) ("rejects unrelated hostname %s before dispatch",async(host)=>{
  const fetch=answer([]);await expect(queryPublicMediaDns(host,undefined,fetch)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
 });
 it.each([[{type:1,data:"127.0.0.1"}],[{type:1,data:"198.18.0.1"}],[{type:1,data:"8.8.8.8"},{type:1,data:"10.0.0.1"}],[]])("rejects empty or non-public replies %#",async(records)=>{
  await expect(queryPublicMediaDns("cdn.bilivideo.cn",undefined,answer(records))).rejects.toThrow();
 });
 it("rejects failed DNS status, huge replies and redirects",async()=>{
  await expect(queryPublicMediaDns("cdn.bilivideo.com",undefined,answer([],3))).rejects.toThrow();
  await expect(queryPublicMediaDns("cdn.bilivideo.com",undefined,answer(new Array(33).fill({type:1,data:"8.8.8.8"})))).rejects.toThrow();
  const fetch=vi.fn(async()=>new Response(null,{status:302,headers:{location:"http://127.0.0.1"}}));
  await expect(queryPublicMediaDns("cdn.bilivideo.com",undefined,fetch)).rejects.toThrow();expect(fetch).toHaveBeenCalledOnce();
 });
 it("honors cancellation before DNS dispatch",async()=>{
  const fetch=answer([]);await expect(queryPublicMediaDns("cdn.bilivideo.com",AbortSignal.abort(),fetch)).rejects.toHaveProperty("name","AbortError");expect(fetch).not.toHaveBeenCalled();
 });
 it("classifies mixed IPv4 and IPv6 benchmark addresses as Fake-IP",async()=>{
  await expect(resolvePinnedAddress("cdn.bilivideo.com",async()=>[{family:4,address:"198.18.0.11"},{family:6,address:"2001:2::b"}])).rejects.toHaveProperty("name","FakeIpDnsError");
 });
});
