import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Speech to Text Skill ─────────────────────────────────────────
// Transcribes audio using OpenAI Whisper API.
// Requires OPENAI_API_KEY environment variable.

const WHISPER_API_URL = "https://api.openai.com/v1/audio/transcriptions";

const SpeechToTextParams = z.object({
  audioUrl: z.string().url().describe("URL to the audio file to transcribe"),
  language: z
    .string()
    .default("en")
    .describe("Language code (ISO 639-1, e.g. 'en', 'es', 'fr'). Default: 'en'"),
  format: z
    .enum(["text", "srt", "vtt"])
    .default("text")
    .describe("Output format: text, srt, or vtt (default: text)"),
});

const FORMAT_MAP: Record<string, string> = {
  text: "text",
  srt: "srt",
  vtt: "vtt",
};

const speechToTextSkill: SkillDefinition = {
  name: "speech_to_text",
  version: "1.0.0",

  manifest: {
    id: "speech_to_text",
    name: "Speech to Text",
    description:
      "Transcribes audio files to text using OpenAI Whisper API. Supports multiple languages and output formats (text, SRT, VTT).",
    category: "transform",
    tools: ["speech_to_text"],
    configFields: [
      {
        name: "apiKey",
        type: "string",
        required: false,
        description: "OpenAI API key for Whisper",
        envVar: "OPENAI_API_KEY",
      },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "speech_to_text",
      description:
        "Transcribe audio from a URL to text using OpenAI Whisper. Supports text, SRT, and VTT output formats. Requires OPENAI_API_KEY.",
      parameters: SpeechToTextParams,

      async execute(params) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          return {
            error: "OPENAI_API_KEY environment variable is not set. Speech-to-text requires the OpenAI Whisper API.",
          };
        }

        try {
          // Fetch the audio file
          const audioResponse = await safeFetch(params.audioUrl, {
            timeoutMs: 60_000,
            maxRetries: 1,
          });

          if (!audioResponse.ok) {
            return {
              error: `Failed to fetch audio from URL: ${audioResponse.status} ${audioResponse.statusText}`,
            };
          }

          const audioBuffer = await audioResponse.arrayBuffer();
          const audioBytes = new Uint8Array(audioBuffer);

          // Determine file extension from URL or content type
          const contentType = audioResponse.headers.get("content-type") ?? "";
          let filename = "audio.mp3";
          if (contentType.includes("wav")) filename = "audio.wav";
          else if (contentType.includes("mp4") || contentType.includes("m4a")) filename = "audio.m4a";
          else if (contentType.includes("webm")) filename = "audio.webm";
          else if (contentType.includes("ogg")) filename = "audio.ogg";
          else if (contentType.includes("flac")) filename = "audio.flac";
          else {
            // Try to extract from URL
            const urlPath = new URL(params.audioUrl).pathname;
            const ext = urlPath.split(".").pop()?.toLowerCase();
            if (ext && ["mp3", "wav", "m4a", "webm", "ogg", "flac", "mp4"].includes(ext)) {
              filename = `audio.${ext}`;
            }
          }

          // Build multipart form data
          const formData = new FormData();
          const blob = new Blob([audioBytes], { type: contentType || "audio/mpeg" });
          formData.append("file", blob, filename);
          formData.append("model", "whisper-1");
          formData.append("language", params.language);
          formData.append("response_format", FORMAT_MAP[params.format] ?? "text");

          // Send to Whisper API
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 120_000);

          const whisperResponse = await fetch(WHISPER_API_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
            body: formData,
            signal: controller.signal,
          });

          clearTimeout(timeout);

          if (!whisperResponse.ok) {
            const errorBody = await whisperResponse.text();
            return {
              error: `Whisper API returned ${whisperResponse.status}: ${errorBody}`,
            };
          }

          const transcription = await whisperResponse.text();

          return {
            audioUrl: params.audioUrl,
            language: params.language,
            format: params.format,
            transcription,
            characterCount: transcription.length,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: `Speech-to-text failed: ${message}` };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "speech_to_text",
      instructions:
        "You can transcribe audio to text using the `speech_to_text` tool. Provide an audio URL and optionally specify language and output format (text, srt, vtt). Requires OPENAI_API_KEY.",
    };
  },
};

export default speechToTextSkill;
