// Entirely synthetic IDs, texts, and unsigned media addresses.
export const DOUYIN_ID = "9999999999999999999";
export function douyinItem(extra: Record<string, unknown> = {}) {
  return { aweme_id: DOUYIN_ID, desc: "合成视频‮标题", author: { nickname: "测试\u0000作者" }, aweme_type: 0,
    video: { duration: 12_500, cover: { url_list: ["https://images.example.com/cover.jpg"] },
      play_addr: { url_list: ["https://fixture.douyinvod.com/video.mp4"], width: 640, height: 360 } }, ...extra };
}
export function routerHtml(item: unknown = douyinItem()): string {
  return `<html><script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { "video_(id)/page": { videoInfoRes: { item_list: [item] } } } })};</script></html>`;
}
export function renderHtml(item: unknown = douyinItem()): string {
  return `<script type="application/json" id="RENDER_DATA">${encodeURIComponent(JSON.stringify({ detail: item }))}</script>`;
}
