import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Video Metadata Skill ────────────────────────────────────────────
// Extract metadata from video URLs including duration, resolution,
// format, and content info. Uses YouTube Data API for YouTube URLs.

const MetadataParams = z.object({
  url: z.string().url().describe("Video URL (YouTube, Vimeo, or direct)"),
});

const YouTubeSearchParams = z.object({
  query: z.string().describe("Search query"),
  limit: z.number().int().min(1).max(25).default(5),
});

function extractYouTubeId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1]!;
  }
  return null;
}

const videoMetadataSkill: SkillDefinition = {
  name: "video_metadata",
  version: "1.0.0",

  manifest: {
    id: "video_metadata",
    name: "Video Metadata",
    description: "Extract video metadata from URLs. Supports YouTube and direct video links.",
    category: "search",
    tools: ["video_info", "youtube_search"],
    configFields: [
      { name: "youtubeApiKey", type: "string", required: false, description: "YouTube Data API key", envVar: "YOUTUBE_API_KEY" },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "video_info",
      description: "Get metadata for a video URL (title, duration, resolution, views).",
      parameters: MetadataParams,

      async execute(params) {
        const ytId = extractYouTubeId(params.url);
        const apiKey = process.env.YOUTUBE_API_KEY;

        if (ytId && apiKey) {
          const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${ytId}&key=${apiKey}`;
          const res = await safeFetch(url, { ssrfProtection: false });
          if (res.ok) {
            const data = (await res.json()) as {
              items?: Array<{
                snippet: { title: string; description: string; channelTitle: string; publishedAt: string; thumbnails: Record<string, { url: string }> };
                contentDetails: { duration: string; definition: string };
                statistics: { viewCount: string; likeCount: string; commentCount: string };
              }>;
            };

            const item = data.items?.[0];
            if (item) {
              // Parse ISO 8601 duration
              const dur = item.contentDetails.duration;
              const match = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
              const hours = parseInt(match?.[1] ?? "0", 10);
              const minutes = parseInt(match?.[2] ?? "0", 10);
              const seconds = parseInt(match?.[3] ?? "0", 10);

              return {
                platform: "youtube",
                videoId: ytId,
                title: item.snippet.title,
                channel: item.snippet.channelTitle,
                description: item.snippet.description?.slice(0, 500),
                publishedAt: item.snippet.publishedAt,
                duration: `${hours > 0 ? hours + "h " : ""}${minutes}m ${seconds}s`,
                durationSeconds: hours * 3600 + minutes * 60 + seconds,
                definition: item.contentDetails.definition,
                views: parseInt(item.statistics.viewCount, 10),
                likes: parseInt(item.statistics.likeCount, 10),
                comments: parseInt(item.statistics.commentCount, 10),
                thumbnail: item.snippet.thumbnails.high?.url ?? item.snippet.thumbnails.default?.url,
              };
            }
          }
        }

        if (ytId) {
          return {
            platform: "youtube",
            videoId: ytId,
            url: params.url,
            note: apiKey ? "Could not fetch video details." : "Set YOUTUBE_API_KEY for full metadata. Basic info: YouTube video detected.",
          };
        }

        // Non-YouTube: try HEAD request for basic info
        try {
          const res = await safeFetch(params.url, { method: "HEAD", timeoutMs: 10_000 });
          return {
            url: params.url,
            contentType: res.headers.get("content-type"),
            size: parseInt(res.headers.get("content-length") ?? "0", 10),
            status: res.status,
          };
        } catch (err) {
          return { url: params.url, error: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    ctx.registerTool({
      name: "youtube_search",
      description: "Search YouTube for videos by keyword.",
      parameters: YouTubeSearchParams,

      async execute(params) {
        const apiKey = process.env.YOUTUBE_API_KEY;
        if (!apiKey) return { error: "YOUTUBE_API_KEY not configured." };

        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(params.query)}&maxResults=${params.limit}&key=${apiKey}`;
        const res = await safeFetch(url, { ssrfProtection: false });
        if (!res.ok) return { error: `YouTube API error ${res.status}` };

        const data = (await res.json()) as {
          items?: Array<{
            id: { videoId: string };
            snippet: { title: string; channelTitle: string; publishedAt: string; description: string };
          }>;
        };

        return {
          query: params.query,
          count: data.items?.length ?? 0,
          videos: (data.items ?? []).map((item) => ({
            videoId: item.id.videoId,
            title: item.snippet.title,
            channel: item.snippet.channelTitle,
            published: item.snippet.publishedAt,
            description: item.snippet.description?.slice(0, 200),
            url: `https://youtube.com/watch?v=${item.id.videoId}`,
          })),
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "video_metadata",
      instructions: "You can get video info with `video_info` (metadata for any video URL, rich data for YouTube) and `youtube_search` (search YouTube). Requires YOUTUBE_API_KEY for full features.",
    };
  },
};

export default videoMetadataSkill;
