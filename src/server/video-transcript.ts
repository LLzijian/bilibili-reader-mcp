import type { AsrTranscriptionResult } from "../asr/transcription.js";
import { filterSegmentsByRange, mergeSubtitleText, searchTranscript } from "../bilibili/subtitle.js";
import type { TranscriptMatch } from "../bilibili/types.js";
import type { VideoSource } from "../platforms/types.js";
import { SECURITY_LIMITS, utf8ByteLength } from "../security/limits.js";
import { ResourceLimitError } from "../utils/errors.js";

export interface VideoTranscriptOptions {
  includeTimestamps?: boolean;
  startSeconds?: number;
  endSeconds?: number;
  query?: string;
  maxMatches?: number;
  contextSegments?: number;
}

/** Format cross-platform ASR output using the same range/search rules as Bilibili. */
export function formatVideoTranscript(
  source: VideoSource,
  result: AsrTranscriptionResult,
  options: VideoTranscriptOptions = {},
): Record<string, unknown> {
  const body = filterSegmentsByRange(result.segments, options.startSeconds, options.endSeconds);
  const base = {
    platform: source.platform,
    video_id: source.videoId,
    title: source.title,
    source_url: source.canonicalUrl,
    data_source: "asr",
    language: result.language,
  };
  if (options.query === undefined) {
    return { ...base, transcript: mergeSubtitleText(body, options.includeTimestamps) };
  }
  const envelope = (transcript: string, matches: TranscriptMatch[], totalMatches: number) => ({
    ...base, transcript, query: options.query, total_matches: totalMatches,
    returned_matches: matches.length, truncated: totalMatches > matches.length,
    // Douyin has no guaranteed browser timestamp seek. Preserve precise times
    // while linking to the canonical video rather than fabricating seek URLs.
    matches: matches.map((match) => ({ ...match, timestamp_url: source.canonicalUrl })),
  });
  const search = searchTranscript(body, options.query, options.maxMatches ?? 10,
    options.contextSegments ?? 1, source.canonicalUrl, envelope);
  const payload = envelope(search.compactTranscript, search.matches, search.totalMatches);
  if (utf8ByteLength(JSON.stringify(payload)) > SECURITY_LIMITS.transcriptSearchBytes) {
    throw new ResourceLimitError("Transcript search result exceeded its byte limit",
      "transcript_search_result", SECURITY_LIMITS.transcriptSearchBytes);
  }
  return payload;
}
