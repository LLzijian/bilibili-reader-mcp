import type { MediaCandidateSet, MediaStreamCandidate } from "../platforms/types.js";
import { PlatformError } from "../utils/errors.js";
import { DOUYIN_USER_AGENT, validateDouyinMediaUrl } from "./http.js";
import { object, type DouyinVideo } from "./metadata.js";

export const MAX_DOUYIN_MEDIA_CANDIDATES = 8;
function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function candidates(address: unknown, representation: unknown, mimeType: string, limit: number): MediaStreamCandidate[] {
  const addr = object(address);
  const rep = object(representation);
  const rawUrls = addr?.url_list ?? addr?.urlList;
  // Public schema: https://amagi.apifox.cn/schema-313723532,
  // bit_rate_audio[].audio_meta.url_list.{main_url,backup_url,fallback_url}.
  const urlObject = object(rawUrls);
  const urls = urlObject ? [urlObject.main_url, urlObject.backup_url, urlObject.fallback_url] : rawUrls;
  const declaredMime = rep?.mime_type ?? rep?.mimeType ?? addr?.mime_type ?? addr?.mimeType;
  const format = addr?.format ?? rep?.format;
  if (!Array.isArray(urls) || urls.length > 256 || (declaredMime && declaredMime !== mimeType) ||
    (typeof format === "string" && !["mp4", "m4a", "m4s"].includes(format.toLowerCase()))) return [];
  const result: MediaStreamCandidate[] = [];
  for (const raw of urls) {
    let url: string;
    try { url = validateDouyinMediaUrl(raw); } catch { continue; }
    if (result.some((item) => item.url === url)) continue;
    result.push({ url, mimeType,
      bandwidth: positive(rep?.bit_rate ?? rep?.bandwidth ?? addr?.bit_rate ?? addr?.bitrate),
      width: positive(addr?.width ?? rep?.width), height: positive(addr?.height ?? rep?.height) });
    if (result.length >= limit) break;
  }
  return result;
}

export function parseDouyinMediaCandidates(video: DouyinVideo): MediaCandidateSet {
  const data = object(video.item.video);
  const common = { durationSeconds: video.source.durationSeconds,
    requestHeaders: { Referer: "https://www.douyin.com/", "User-Agent": DOUYIN_USER_AGENT } };
  // play_addr is the share-page progressive MP4. Music previews are never
  // substituted for the video's audio track.
  const progressive = candidates(data?.play_addr ?? data?.playAddr ?? data?.play_addr_h264, data, "video/mp4", MAX_DOUYIN_MEDIA_CANDIDATES);
  if (progressive.length) return { ...common, progressive };
  const rates = data?.bit_rate ?? data?.bitRate;
  const audioRates = data?.bit_rate_audio ?? video.item.bit_rate_audio;
  const audio: MediaStreamCandidate[] = [];
  if (Array.isArray(audioRates) && audioRates.length <= 256) {
    for (const rate of audioRates) {
      const rep = object(rate);
      audio.push(...candidates(rep?.play_addr ?? rep?.playAddr ?? rep?.audio_addr ?? rep?.audio_meta, rep, "audio/mp4", 4 - audio.length));
      if (audio.length >= 4) break;
    }
  }
  const tracks: MediaStreamCandidate[] = [];
  if (Array.isArray(rates) && rates.length <= 256) {
    const maxVideo = MAX_DOUYIN_MEDIA_CANDIDATES - audio.length;
    for (const rate of rates) {
      const rep = object(rate);
      const addr = rep?.play_addr ?? rep?.playAddr;
      for (const candidate of candidates(addr, rep, "video/mp4", maxVideo - tracks.length)) {
        if (!tracks.some((item) => item.url === candidate.url)) tracks.push(candidate);
      }
      if (tracks.length >= maxVideo) break;
    }
  }
  if (tracks.length && audio.length) return { ...common, split: { video: tracks, audio } };
  // Douyin bit_rate play_addr is also progressive when no separate audio
  // metadata is advertised. An advertised but invalid audio track must fail.
  if (tracks.length && audioRates === undefined) return { ...common, progressive: tracks };
  throw new PlatformError("DOUYIN_MEDIA_UNAVAILABLE", "Douyin did not provide supported MP4 media candidates.");
}
