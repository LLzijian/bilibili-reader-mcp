import type { ImageContent, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { transcribeAudioFile } from "../asr/transcription.js";
import { extractVideoFrame } from "../bilibili/frames.js";
import { withMediaAsset } from "../media/acquire.js";
import { ensureDefaultMediaSources } from "../media/default-sources.js";
import { extractVideoClips, validateClipRanges } from "../media/clips.js";
import type { ClipRange } from "../media/clips.js";
import { extractKeyframes } from "../media/keyframes.js";
import type { KeyframeOptions } from "../media/keyframes.js";
import { resolveVideoSource } from "../platforms/registry.js";
import type { VideoSource } from "../platforms/types.js";
import { getOperationSignal, throwIfAborted } from "../security/operation-context.js";
import { MediaError, ValidationError } from "../utils/errors.js";
import { assertBoundedToolResult } from "./error-response.js";
import { formatVideoTranscript } from "./video-transcript.js";
import type { VideoTranscriptOptions } from "./video-transcript.js";

function imageResult(source: VideoSource, frames: Array<{ timestampSeconds: number; image: Buffer }>) {
  const content: Array<TextContent | ImageContent> = [];
  for (const frame of frames) {
    const url = new URL(source.canonicalUrl);
    if (source.platform === "bilibili") url.searchParams.set("t", String(frame.timestampSeconds));
    content.push({ type: "text", text: JSON.stringify({
      platform: source.platform, video_id: source.videoId, title: source.title,
      timestamp_seconds: frame.timestampSeconds, source_url: url.toString(),
      ...(source.page === undefined ? {} : { page: source.page }),
    }) });
    content.push({ type: "image", mimeType: "image/jpeg", data: frame.image.toString("base64") });
  }
  const result = { content };
  assertBoundedToolResult(result);
  return result;
}

export async function readDouyinTranscript(input: string, options: VideoTranscriptOptions, callerSignal?: AbortSignal) {
  const signal = getOperationSignal(callerSignal);
  throwIfAborted(signal);
  ensureDefaultMediaSources();
  const source = await resolveVideoSource(input, signal);
  return withMediaAsset(source, { purpose: "transcript" }, async (asset) => {
    if (!asset.hasAudio) throw new MediaError("MEDIA_NO_AUDIO_TRACK", "The selected media has no audio track.");
    const audioPath = asset.audioPath ?? asset.videoPath;
    if (!audioPath) throw new MediaError("MEDIA_NO_AUDIO_TRACK", "No local audio is available.");
    const result = await transcribeAudioFile({ audioPath, durationSeconds: asset.durationSeconds }, undefined, signal);
    return formatVideoTranscript(source, result, options);
  }, signal);
}

export async function readDouyinFrames(input: string, timestamps: number[], callerSignal?: AbortSignal) {
  const signal = getOperationSignal(callerSignal);
  throwIfAborted(signal);
  ensureDefaultMediaSources();
  const source = await resolveVideoSource(input, signal);
  // Reject invalid ranges before downloading when platform metadata is sufficient.
  if (timestamps.some((time) => time >= source.durationSeconds)) {
    throw new ValidationError("timestamps must be within the video duration");
  }
  return withMediaAsset(source, { purpose: "frames" }, async (asset) => {
    if (!asset.hasVideo || !asset.videoPath) throw new MediaError("MEDIA_NO_VIDEO_TRACK", "No local video is available.");
    if (timestamps.some((time) => time >= asset.durationSeconds)) throw new ValidationError("timestamps must be within the actual video duration");
    const frames = [];
    for (const timestampSeconds of timestamps) {
      throwIfAborted(signal);
      frames.push({ timestampSeconds, image: await extractVideoFrame(asset.videoPath, timestampSeconds, signal) });
    }
    return imageResult(source, frames);
  }, signal);
}

export async function readVideoKeyframes(input: string, options: KeyframeOptions, callerSignal?: AbortSignal) {
  const signal = getOperationSignal(callerSignal);
  throwIfAborted(signal);
  ensureDefaultMediaSources();
  const source = await resolveVideoSource(input, signal);
  return withMediaAsset(source, { purpose: "keyframes" }, async (asset) =>
    imageResult(source, await extractKeyframes(asset, options, signal)), signal);
}

export async function createVideoClips(input: string, clips: ClipRange[], callerSignal?: AbortSignal) {
  const signal = getOperationSignal(callerSignal);
  throwIfAborted(signal);
  ensureDefaultMediaSources();
  const source = await resolveVideoSource(input, signal);
  validateClipRanges(clips, source.durationSeconds);
  return withMediaAsset(source, { purpose: "clips" }, async (asset) => ({
    platform: source.platform, video_id: source.videoId, source_url: source.canonicalUrl,
    clips: (await extractVideoClips(asset, clips, signal)).map((clip) => ({
      clip_id: clip.clipId, label: clip.label, start_seconds: clip.startSeconds,
      end_seconds: clip.endSeconds, duration_seconds: clip.durationSeconds,
      file_path: clip.filePath, has_audio: clip.hasAudio, content_type: clip.contentType,
      size_bytes: clip.sizeBytes,
    })),
  }), signal);
}
