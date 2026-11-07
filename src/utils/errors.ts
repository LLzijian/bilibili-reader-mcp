/**
 * 错误处理模块
 * 提供详细的错误类型和错误处理功能
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class BVIdError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'BVIdError';
  }
}

export class InputLengthError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'InputLengthError';
  }
}

export class UnsafeInputError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeInputError';
  }
}

export class NetworkError extends Error {
  constructor(
    message: string,
    public originalError?: Error,
    public url?: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class TimeoutError extends Error {
  constructor(message: string, public timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class ResourceLimitError extends Error {
  constructor(
    message: string,
    public resource: string,
    public limit: number,
  ) {
    super(message);
    this.name = "ResourceLimitError";
  }
}

export class UpstreamResponseError extends Error {
  constructor(message: string = "Remote service returned an invalid response") {
    super(message);
    this.name = "UpstreamResponseError";
  }
}

export class BilibiliAPIError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number,
    public originalError?: any
  ) {
    super(message);
    this.name = 'BilibiliAPIError';
  }
}

export class PaidVideoError extends Error {
  constructor(message: string = '该视频为付费内容，无法获取完整信息') {
    super(message);
    this.name = 'PaidVideoError';
  }
}

export class NoSubtitleError extends Error {
  constructor(message: string = '该视频没有可用的字幕') {
    super(message);
    this.name = 'NoSubtitleError';
  }
}

export type AsrErrorCode =
  | "ASR_NOT_READY"
  | "ASR_AUDIO_UNAVAILABLE"
  | "ASR_FAKE_IP_DNS"
  | "ASR_LIMIT_EXCEEDED"
  | "ASR_BUSY"
  | "ASR_TRANSCRIPTION_TIMEOUT"
  | "ASR_TRANSCRIPTION_FAILED"
  | "ASR_OUTPUT_INVALID";

export class AsrError extends Error {
  constructor(
    public code: AsrErrorCode,
    message: string,
    public retryable: boolean = false,
  ) {
    super(message);
    this.name = "AsrError";
  }
}

export class CommentsDisabledError extends Error {
  constructor(message: string = '该视频的评论功能已被禁用或限制访问') {
    super(message);
    this.name = 'CommentsDisabledError';
  }
}

/**
 * Cross-platform media error vocabulary (frozen 2026-11-07).
 * New platform / media / keyframe / clip code throws one of these so the
 * MCP layer can map every failure into the structured error system.
 */

export type PlatformErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "PLATFORM_URL_INVALID"
  | "PLATFORM_RESOLVE_FAILED"
  | "DOUYIN_ACCESS_DENIED"
  | "DOUYIN_CHALLENGE_REQUIRED"
  | "DOUYIN_VIDEO_UNAVAILABLE"
  | "DOUYIN_MEDIA_UNAVAILABLE";

export class PlatformError extends Error {
  constructor(
    public code: PlatformErrorCode,
    message: string,
    public retryable: boolean = false,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

export type MediaErrorCode =
  | "MEDIA_DOWNLOAD_TIMEOUT"
  | "MEDIA_DOWNLOAD_FAILED"
  | "MEDIA_LIMIT_EXCEEDED"
  | "MEDIA_PROBE_FAILED"
  | "MEDIA_NO_VIDEO_TRACK"
  | "MEDIA_NO_AUDIO_TRACK"
  | "MEDIA_MUX_FAILED"
  | "MEDIA_CANDIDATES_UNAVAILABLE"
  | "MEDIA_FAKE_IP_DNS";

export class MediaError extends Error {
  constructor(
    public code: MediaErrorCode,
    message: string,
    public retryable: boolean = false,
  ) {
    super(message);
    this.name = "MediaError";
  }
}

export type KeyframeErrorCode =
  | "KEYFRAME_NO_VIDEO"
  | "KEYFRAME_FAILED"
  | "KEYFRAME_LIMIT_EXCEEDED";

export class KeyframeError extends Error {
  constructor(
    public code: KeyframeErrorCode,
    message: string,
    public retryable: boolean = false,
  ) {
    super(message);
    this.name = "KeyframeError";
  }
}

export type ClipErrorCode =
  | "CLIP_INVALID_RANGE"
  | "CLIP_LIMIT_EXCEEDED"
  | "CLIP_FAILED";

export class ClipError extends Error {
  constructor(
    public code: ClipErrorCode,
    message: string,
    public retryable: boolean = false,
  ) {
    super(message);
    this.name = "ClipError";
  }
}

export class FfmpegUnavailableError extends Error {
  constructor(message: string = "FFmpeg is unavailable. Install FFmpeg or set BILIBILI_FFMPEG_PATH.") {
    super(message);
    this.name = "FfmpegUnavailableError";
  }
}

/**
 * 分类错误类型
 */
export function categorizeError(error: any): Error {
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return new TimeoutError('Request aborted due to timeout', 30000);
    }
    if (error.name === 'FetchError' || (error as any).code === 'ECONNRESET') {
      return new NetworkError('Network error', error);
    }
  }
  return error;
}

/**
 * 安全地处理输入验证错误
 */
export function handleValidationError(error: unknown): never {
  if (error instanceof ValidationError) {
    throw error;
  }
  
  if (error instanceof Error) {
    throw new ValidationError(`Validation failed: ${error.message}`);
  }
  
  throw new ValidationError('Unknown validation error');
}
