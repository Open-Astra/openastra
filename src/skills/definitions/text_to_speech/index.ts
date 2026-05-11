import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Text-to-Speech Skill ────────────────────────────────────────────
// Convert text to audio via ElevenLabs or OpenAI TTS API.
// Requires TTS_API_KEY and optionally TTS_PROVIDER.

const SpeakParams = z.object({
  text: z.string().max(5000).describe("Text to convert to speech"),
  voice: z.string().default("alloy").describe("Voice ID (OpenAI: alloy/echo/fable/onyx/nova/shimmer, ElevenLabs: voice ID)"),
  speed: z.number().min(0.25).max(4.0).default(1.0).describe("Speaking speed (0.25-4.0)"),
});

const ListVoicesParams = z.object({});

const textToSpeechSkill: SkillDefinition = {
  name: "text_to_speech",
  version: "1.0.0",

  manifest: {
    id: "text_to_speech",
    name: "Text-to-Speech",
    description: "Convert text to audio using OpenAI TTS or ElevenLabs. Supports multiple voices and speeds.",
    category: "execute",
    tools: ["tts_speak", "tts_voices"],
    configFields: [
      { name: "apiKey", type: "string", required: true, description: "TTS API key", envVar: "TTS_API_KEY" },
      { name: "provider", type: "string", required: false, description: "TTS provider (openai or elevenlabs)", envVar: "TTS_PROVIDER" },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    const getConfig = () => ({
      apiKey: process.env.TTS_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
      provider: (process.env.TTS_PROVIDER ?? "openai") as "openai" | "elevenlabs",
    });

    ctx.registerTool({
      name: "tts_speak",
      description: "Convert text to speech audio. Returns audio data details.",
      parameters: SpeakParams,

      async execute(params) {
        const { apiKey, provider } = getConfig();
        if (!apiKey) return { error: "TTS_API_KEY not configured." };

        if (provider === "elevenlabs") {
          const res = await safeFetch(`https://api.elevenlabs.io/v1/text-to-speech/${params.voice}`, {
            method: "POST",
            headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              text: params.text,
              model_id: "eleven_monolingual_v1",
              voice_settings: { stability: 0.5, similarity_boost: 0.75 },
            }),
            timeoutMs: 30_000,
            ssrfProtection: false,
          });

          if (!res.ok) return { error: `ElevenLabs API error ${res.status}` };

          const audioSize = parseInt(res.headers.get("content-length") ?? "0", 10);
          return {
            provider: "elevenlabs",
            voice: params.voice,
            textLength: params.text.length,
            audioSize,
            contentType: res.headers.get("content-type"),
            note: "Audio generated successfully. Stream from API in production.",
          };
        }

        // OpenAI TTS
        const res = await safeFetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "tts-1",
            input: params.text,
            voice: params.voice,
            speed: params.speed,
          }),
          timeoutMs: 30_000,
          ssrfProtection: false,
        });

        if (!res.ok) {
          const err = await res.text();
          return { error: `OpenAI TTS error ${res.status}: ${err.slice(0, 300)}` };
        }

        const audioSize = parseInt(res.headers.get("content-length") ?? "0", 10);
        return {
          provider: "openai",
          voice: params.voice,
          speed: params.speed,
          textLength: params.text.length,
          audioSize,
          contentType: res.headers.get("content-type"),
          note: "Audio generated. In production, stream to client or save to file.",
        };
      },
    });

    ctx.registerTool({
      name: "tts_voices",
      description: "List available TTS voices.",
      parameters: ListVoicesParams,

      async execute() {
        const { provider } = getConfig();

        if (provider === "elevenlabs") {
          return {
            provider: "elevenlabs",
            note: "ElevenLabs has hundreds of voices. Use their API or website to browse.",
            defaultVoices: ["Rachel", "Domi", "Bella", "Antoni", "Elli", "Josh", "Arnold", "Adam", "Sam"],
          };
        }

        return {
          provider: "openai",
          voices: [
            { id: "alloy", description: "Neutral and balanced" },
            { id: "echo", description: "Warm and clear" },
            { id: "fable", description: "British and expressive" },
            { id: "onyx", description: "Deep and authoritative" },
            { id: "nova", description: "Friendly and energetic" },
            { id: "shimmer", description: "Gentle and soothing" },
          ],
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "text_to_speech",
      instructions: "You can convert text to speech with `tts_speak` (generate audio) and `tts_voices` (list available voices). Supports OpenAI TTS and ElevenLabs. Requires TTS_API_KEY.",
    };
  },
};

export default textToSpeechSkill;
