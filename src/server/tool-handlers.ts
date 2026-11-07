import { detectPlatform, resolveVideoSource } from "../platforms/registry.js";
import { validateKeyframeOptions } from "../media/keyframes.js";
import { validateClipRanges } from "../media/clips.js";
import { createVideoClips, readDouyinFrames, readDouyinTranscript, readVideoKeyframes } from "./video-services.js";
import { getVideoChaptersData } from "../bilibili/chapters.js";
import { getVideoCommentsData } from "../bilibili/comments.js";
import { getBilibiliCreatorContent } from "../bilibili/creator-content.js";
import { getVideoFrames, validateFrameTimestamps } from "../bilibili/frames.js";
import { checkLoginStatus } from "../bilibili/http.js";
import { getVideoMetadataData } from "../bilibili/metadata.js";
import {
  searchBilibiliCreators,
  searchBilibiliVideos,
} from "../bilibili/search.js";
import {
  getVideoInfoWithSubtitle,
  getVideoTranscriptData,
} from "../bilibili/subtitle.js";
import { getPreferredLanguage } from "../config.js";
import {
  buildCredentialSetupInstructions,
  buildCredentialStatus,
} from "../utils/credential-guidance.js";
import { buildStructuredErrorPayload } from "../utils/error-guidance.js";
import {
  AsrError,
  NoSubtitleError,
  ValidationError,
} from "../utils/errors.js";
import { sanitizeBVInput } from "../utils/sanitization.js";
import { buildPackageUpdateInfo } from "../utils/update-check.js";
import {
  validateBoolean,
  validateBVInput,
  validateCommentLimit,
  validateCommentSort,
  validateContextSegments,
  validateCreatorContentInput,
  validateDetailLevel,
  validateLanguage,
  validateMaxMatches,
  validatePage,
  validateQuery,
  validateSearchLimit,
  validateTimestampRange,
} from "../utils/validation.js";
import {
  buildValidationErrorPayload,
  toErrorTextContent,
  toStructuredContent,
  toTextContent,
} from "./error-response.js";

type ToolArgs = Record<string, unknown> | undefined;
const KNOWN_TOOL_NAMES = new Set([
  "get_credential_setup_instructions",
  "check_bilibili_credentials",
  "check_mcp_update",
  "get_video_info",
  "get_video_comments",
  "get_video_transcript",
  "get_video_metadata",
  "get_video_chapters",
  "search_bilibili_videos",
  "search_bilibili_creators",
  "get_video_frames",
  "get_video_keyframes",
  "extract_video_clips",
  "get_bilibili_creator_content",
]);

function isDouyinInput(input: unknown): input is string {
  return typeof input === "string" && Buffer.byteLength(input, "utf8") <= 8192 && detectPlatform(input) === "douyin";
}

function validateVideoToolArguments(args: ToolArgs, keys: readonly string[]): asserts args is Record<string, unknown> & { url: string } {
  if (!args || Array.isArray(args) || Object.keys(args).some((key) => !keys.includes(key))) {
    throw new ValidationError("Invalid or unsupported video tool arguments");
  }
  if (typeof args.url !== "string" || args.url.length === 0 || Buffer.byteLength(args.url, "utf8") > 8192) {
    throw new ValidationError("url must be a supported video link of at most 8192 bytes");
  }
}

export async function handleToolCall(
  name: string,
  args: ToolArgs,
  signal?: AbortSignal,
) {
  if (name.length > 128 || !KNOWN_TOOL_NAMES.has(name)) {
    throw new Error("Unknown MCP tool");
  }
  switch (name) {
    case "get_credential_setup_instructions": {
      return toTextContent(buildCredentialSetupInstructions());
    }

    case "check_bilibili_credentials": {
      const result = await buildCredentialStatus(checkLoginStatus);
      return toTextContent(result);
    }

    case "check_mcp_update": {
      const result = await buildPackageUpdateInfo(globalThis.fetch, signal);
      return toTextContent(result);
    }

    case "get_video_info": {
      const bvidOrUrl = args?.bvid_or_url as string;
      const preferredLang = args?.preferred_lang as string | undefined;
      const page = args?.page as number | undefined;
      const excludeAiSubtitles = (args?.exclude_ai_subtitles as boolean) || false;

      let sanitizedBvidOrUrl: string;
      try {
        validateBVInput(bvidOrUrl);
        validateLanguage(preferredLang);
        validatePage(page);
        validateBoolean(args?.exclude_ai_subtitles, "exclude_ai_subtitles");
        sanitizedBvidOrUrl = sanitizeBVInput(bvidOrUrl);
      } catch (error) {
        return toErrorTextContent(buildValidationErrorPayload(error));
      }

      const normalizedLang = getPreferredLanguage(preferredLang);
      const result = await getVideoInfoWithSubtitle(sanitizedBvidOrUrl, normalizedLang, page, excludeAiSubtitles);

      return toTextContent(result);
    }

    case "get_video_comments": {
      const bvidOrUrl = args?.bvid_or_url as string;
      const detailLevel = (args?.detail_level as "brief" | "detailed") || "brief";
      const limit = args?.limit as number | undefined;
      const sort = args?.sort as "hot" | "time" | undefined;
      const includeReplies = args?.include_replies as boolean | undefined;

      let sanitizedBvidOrUrl: string;
      try {
        validateBVInput(bvidOrUrl);
        validateDetailLevel(detailLevel);
        if (limit !== undefined) validateCommentLimit(limit);
        if (sort !== undefined) validateCommentSort(sort);
        if (includeReplies !== undefined && typeof includeReplies !== "boolean") {
          throw new ValidationError("include_replies must be a boolean");
        }
        sanitizedBvidOrUrl = sanitizeBVInput(bvidOrUrl);
      } catch (error) {
        return toErrorTextContent(buildValidationErrorPayload(error));
      }

      const result = await getVideoCommentsData(sanitizedBvidOrUrl, {
        detailLevel,
        limit,
        sort,
        includeReplies,
      });

      return toTextContent(result);
    }

    case "get_video_transcript": {
      const bvidOrUrl = args?.bvid_or_url as string;
      const preferredLang = args?.preferred_lang as string | undefined;
      const fallbackToDescription = (args?.fallback_to_description as boolean) || false;
      const fallbackToAsr = (args?.fallback_to_asr as boolean) || false;
      const excludeAiSubtitles = (args?.exclude_ai_subtitles as boolean) || false;
      const forceAsr = (args?.force_asr as boolean) || false;
      const page = args?.page as number | undefined;
      const includeTimestamps = args?.include_timestamps as boolean | undefined;
      const startSeconds = args?.start_seconds as number | undefined;
      const endSeconds = args?.end_seconds as number | undefined;
      const query = args?.query as string | undefined;
      const maxMatches = args?.max_matches as number | undefined;
      const contextSegments = args?.context_segments as number | undefined;

      let sanitizedBvidOrUrl: string;
      try {
        if (!isDouyinInput(bvidOrUrl)) validateBVInput(bvidOrUrl);
        validateLanguage(preferredLang);
        validatePage(page);
        if (isDouyinInput(bvidOrUrl) && page !== undefined) throw new ValidationError("page is only supported for Bilibili");
        validateBoolean(args?.fallback_to_description, "fallback_to_description");
        validateBoolean(args?.fallback_to_asr, "fallback_to_asr");
        validateBoolean(includeTimestamps, "include_timestamps");
        validateTimestampRange(startSeconds, endSeconds);
        validateBoolean(args?.exclude_ai_subtitles, "exclude_ai_subtitles");
        validateBoolean(args?.force_asr, "force_asr");
        validateQuery(query);
        validateMaxMatches(maxMatches);
        validateContextSegments(contextSegments);
        sanitizedBvidOrUrl = isDouyinInput(bvidOrUrl) ? bvidOrUrl : sanitizeBVInput(bvidOrUrl);
      } catch (error) {
        return toErrorTextContent(buildValidationErrorPayload(error));
      }

      const normalizedLang = getPreferredLanguage(preferredLang);

      const searchOptions = query !== undefined
        ? {
            query: query.trim(),
            max_matches: maxMatches ?? 10,
            context_segments: contextSegments ?? 1,
          }
        : undefined;

      try {
        if (isDouyinInput(sanitizedBvidOrUrl)) {
          if (!fallbackToAsr && !forceAsr) return toErrorTextContent(buildStructuredErrorPayload(new NoSubtitleError(), { platform: "douyin" }));
          return toStructuredContent(await readDouyinTranscript(sanitizedBvidOrUrl, {
            includeTimestamps, startSeconds, endSeconds, query: query?.trim(), maxMatches, contextSegments,
          }, signal));
        }
        const transcriptArgs = [
          sanitizedBvidOrUrl,
          normalizedLang,
          fallbackToDescription,
          page,
          includeTimestamps,
          startSeconds,
          endSeconds,
          searchOptions,
          fallbackToAsr,
          excludeAiSubtitles,
          forceAsr,
        ] as const;
        const result = signal === undefined
          ? await getVideoTranscriptData(...transcriptArgs)
          : await getVideoTranscriptData(...transcriptArgs, signal);
        return toStructuredContent(
          result as unknown as Record<string, unknown>,
        );
      } catch (error) {
        if (error instanceof NoSubtitleError || error instanceof AsrError) {
          return toErrorTextContent(
            buildStructuredErrorPayload(error, {
              fallbackToDescriptionAvailable: !includeTimestamps && startSeconds === undefined && endSeconds === undefined && fallbackToDescription !== true,
            }),
          );
        }
        throw error;
      }
    }

    case "get_video_metadata": {
      const bvidOrUrl = args?.bvid_or_url as string;
      if (isDouyinInput(bvidOrUrl)) {
        if (args?.page !== undefined) return toErrorTextContent(buildValidationErrorPayload(new ValidationError("page is only supported for Bilibili")));
        const source = await resolveVideoSource(bvidOrUrl, signal);
        return toStructuredContent({
          platform: source.platform, video_id: source.videoId, source_url: source.canonicalUrl,
          title: source.title, author: source.author, duration_seconds: source.durationSeconds,
          ...(source.coverUrl === undefined ? {} : { cover_url: source.coverUrl }),
        });
      }

      let sanitizedBvidOrUrl: string;
      try {
        validateBVInput(bvidOrUrl);
        sanitizedBvidOrUrl = sanitizeBVInput(bvidOrUrl);
      } catch (error) {
        return toErrorTextContent(buildValidationErrorPayload(error));
      }

      const result = await getVideoMetadataData(sanitizedBvidOrUrl);

      return toTextContent(result);
    }

    case "get_video_chapters": {
      const bvidOrUrl = args?.bvid_or_url as string;
      const page = args?.page as number | undefined;

      let sanitizedBvidOrUrl: string;
      try {
        validateBVInput(bvidOrUrl);
        validatePage(page);
        sanitizedBvidOrUrl = sanitizeBVInput(bvidOrUrl);
      } catch (error) {
        return toErrorTextContent(buildValidationErrorPayload(error));
      }

      const result = await getVideoChaptersData(sanitizedBvidOrUrl, page);

      return toTextContent(result);
    }

    case "search_bilibili_videos": {
      const rawQuery = args?.query;
      const rawLimit = args?.limit;

      try {
        if (rawQuery === undefined) {
          throw new ValidationError("query is required");
        }
        validateQuery(rawQuery);
        validateSearchLimit(rawLimit);
      } catch (error) {
        return toErrorTextContent(buildValidationErrorPayload(error));
      }

      const query = (rawQuery as string).trim();
      const limit = rawLimit === undefined ? 5 : (rawLimit as number);
      const result = await searchBilibiliVideos(query, limit);

      return toStructuredContent(result as unknown as Record<string, unknown>);
    }

    case "search_bilibili_creators": {
      const rawQuery = args?.query;
      const rawLimit = args?.limit;

      try {
        if (rawQuery === undefined) {
          throw new ValidationError("query is required");
        }
        validateQuery(rawQuery);
        validateSearchLimit(rawLimit);
      } catch (error) {
        return toErrorTextContent(buildValidationErrorPayload(error));
      }

      const query = (rawQuery as string).trim();
      const limit = rawLimit === undefined ? 5 : (rawLimit as number);
      const result = await searchBilibiliCreators(query, limit);

      return toStructuredContent(result as unknown as Record<string, unknown>);
    }

    case "get_video_frames": {
      try {
        if (!isDouyinInput(args?.bvid_or_url)) validateBVInput(args?.bvid_or_url);
        validatePage(args?.page);
        if (isDouyinInput(args?.bvid_or_url) && args?.page !== undefined) throw new ValidationError("page is only supported for Bilibili");
        validateFrameTimestamps(args?.timestamps);
      } catch (error) {
        return toErrorTextContent(buildValidationErrorPayload(error));
      }
      if (isDouyinInput(args?.bvid_or_url)) return readDouyinFrames(args.bvid_or_url, args.timestamps as number[], signal);
      return await getVideoFrames(sanitizeBVInput(args!.bvid_or_url as string), args!.timestamps as number[], args?.page as number | undefined, signal);
    }

    case "get_video_keyframes": {
      try {
        validateVideoToolArguments(args, ["url", "max_frames", "strategy"]);
      } catch (error) {
        return toErrorTextContent(buildValidationErrorPayload(error));
      }
      const options = validateKeyframeOptions({ maxFrames: args!.max_frames, strategy: args!.strategy });
      return readVideoKeyframes(args!.url as string, options, signal);
    }

    case "extract_video_clips": {
      try {
        validateVideoToolArguments(args, ["url", "clips"]);
        if (!Array.isArray(args.clips) || args.clips.some((clip) =>
          !clip || typeof clip !== "object" || Array.isArray(clip) ||
          Object.keys(clip).some((key) => !["start_seconds", "end_seconds", "label"].includes(key)))) {
          throw new ValidationError("clips must contain only start_seconds, end_seconds and optional label");
        }
      } catch (error) {
        return toErrorTextContent(buildValidationErrorPayload(error));
      }
      const ranges = (args!.clips as Array<Record<string, unknown>>).map((clip) => ({
        startSeconds: clip.start_seconds, endSeconds: clip.end_seconds, label: clip.label,
      }));
      // Complete count, numeric and total-duration checks before platform I/O;
      // validate again against the resolved and probed source durations later.
      const clips = validateClipRanges(ranges, 7200);
      return toStructuredContent(await createVideoClips(args!.url as string, clips, signal));
    }

    case "get_bilibili_creator_content": {
      const rawMid = args?.mid;
      const rawSection = args?.section;
      const rawContainerId = args?.container_id;
      const rawCursor = args?.cursor;

      try {
        validateCreatorContentInput(
          rawMid,
          rawSection,
          rawCursor,
          rawContainerId,
        );
      } catch (error) {
        return toErrorTextContent(buildValidationErrorPayload(error));
      }

      const mid = rawMid as number;
      const section = rawSection as
        | "overview"
        | "videos"
        | "collections"
        | "series"
        | "dynamics";
      const cursor = typeof rawCursor === "string" ? rawCursor : undefined;
      const result =
        typeof rawContainerId === "number"
          ? await getBilibiliCreatorContent(
              mid,
              section,
              cursor,
              rawContainerId,
            )
          : await getBilibiliCreatorContent(mid, section, cursor);

      return toStructuredContent(result as unknown as Record<string, unknown>);
    }

    default:
      throw new Error("Unknown MCP tool");
  }
}
