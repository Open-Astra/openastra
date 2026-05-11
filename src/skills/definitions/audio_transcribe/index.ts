import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Audio Transcription Skill ───────────────────────────────────────
// Transcribe audio to text via OpenAI Whisper API or compatible.
// Requires WHISPER_API_KEY (OpenAI key) or WHISPER_API_URL.

const TranscribeUrlParams = z.object({
  audioUrl: z.string().url().describe("URL of audio file to transcribe"),
  language: z.string().optional().describe("ISO 639-1 language code (e.g. 'en', 'es')"),
  prompt: z.string().optional().describe("Optional context/prompt to guide transcription"),
});

const TranscribeTextParams = z.object({
  text: z.string().describe("Text to get timestamps for (alignment mode)"),
  audioUrl: z.string().url().describe("URL of audio file"),
});

const audioTranscribeSkill: SkillDefinition = {
  name: "audio_transcribe",
  version: "1.0.0",

  manifest: {
    id: "audio_transcribe",
    name: "Audio Transcription",
    description: "Transcribe audio files to text using Whisper API. Supports multiple languages.",
    category: "transform",
    tools: ["audio_transcribe", "audio_translate"],
    configFields: [
      { name: "apiKey", type: "string", required: true, description: "OpenAI API key for Whisper", envVar: "WHISPER_API_KEY" },
      { name: "apiUrl", type: "string", required: false, description: "Custom Whisper API URL", envVar: "WHISPER_API_URL" },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    const getConfig = () => ({
      apiKey: process.env.WHISPER_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
      apiUrl: process.env.WHISPER_API_URL ?? "https://api.openai.com/v1",
    });

    ctx.registerTool({
      name: "audio_transcribe",
      description: "Transcribe audio from a URL to text. Supports mp3, mp4, mpeg, mpga, m4a, wav, webm.",
      parameters: TranscribeUrlParams,

      async execute(params) {
        const { apiKey, apiUrl } = getConfig();
        if (!apiKey) return { error: "WHISPER_API_KEY or OPENAI_API_KEY not configured." };

        try {
          // Fetch the audio file
          const audioRes = await safeFetch(params.audioUrl, { timeoutMs: 30_000 });
          if (!audioRes.ok) return { error: `Failed to fetch audio: HTTP ${audioRes.status}` };

          const audioBuffer = await audioRes.arrayBuffer();
          const blob = new Blob([audioBuffer]);

          const formData = new FormData();
          formData.append("file", blob, "audio.mp3");
          formData.append("model", "whisper-1");
          if (params.language) formData.append("language", params.language);
          if (params.prompt) formData.append("prompt", params.prompt);
          formData.append("response_format", "verbose_json");

          const res = await safeFetch(`${apiUrl}/audio/transcriptions`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiKey}` },
            body: formData as unknown as string,
            timeoutMs: 120_000,
            ssrfProtection: false,
          });

          if (!res.ok) {
            const err = await res.text();
            return { error: `Whisper API error ${res.status}: ${err.slice(0, 300)}` };
          }

          const data = (await res.json()) as { text: string; language?: string; duration?: number; segments?: Array<{ start: number; end: number; text: string }> };
          return {
            text: data.text,
            language: data.language,
            duration: data.duration,
            segmentCount: data.segments?.length ?? 0,
            segments: data.segments?.slice(0, 50).map((s) => ({ start: s.start, end: s.end, text: s.text })),
          };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    ctx.registerTool({
      name: "audio_translate",
      description: "Translate audio from any language to English text.",
      parameters: TranscribeTextParams,

      async execute(params) {
        const { apiKey, apiUrl } = getConfig();
        if (!apiKey) return { error: "WHISPER_API_KEY not configured." };

        try {
          const audioRes = await safeFetch(params.audioUrl, { timeoutMs: 30_000 });
          if (!audioRes.ok) return { error: `Failed to fetch audio: HTTP ${audioRes.status}` };

          const audioBuffer = await audioRes.arrayBuffer();
          const blob = new Blob([audioBuffer]);

          const formData = new FormData();
          formData.append("file", blob, "audio.mp3");
          formData.append("model", "whisper-1");
          formData.append("prompt", params.text);

          const res = await safeFetch(`${apiUrl}/audio/translations`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiKey}` },
            body: formData as unknown as string,
            timeoutMs: 120_000,
            ssrfProtection: false,
          });

          if (!res.ok) {
            const err = await res.text();
            return { error: `Whisper API error ${res.status}: ${err.slice(0, 300)}` };
          }

          const data = (await res.json()) as { text: string };
          return { translatedText: data.text, note: "Translated to English" };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "audio_transcribe",
      instructions: "You can transcribe audio with `audio_transcribe` (speech-to-text in any language) and `audio_translate` (translate audio to English). Uses Whisper API. Requires WHISPER_API_KEY.",
    };
  },
};

export default audioTranscribeSkill;
