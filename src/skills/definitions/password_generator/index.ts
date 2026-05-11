import { z } from "zod";
import { randomBytes, randomInt } from "node:crypto";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Password Generator Skill ────────────────────────────────────────
// Generate cryptographically secure passwords and passphrases.

const PasswordParams = z.object({
  length: z.number().int().min(8).max(128).default(20).describe("Password length"),
  includeUppercase: z.boolean().default(true),
  includeLowercase: z.boolean().default(true),
  includeNumbers: z.boolean().default(true),
  includeSymbols: z.boolean().default(true),
  excludeAmbiguous: z.boolean().default(false).describe("Exclude ambiguous chars (l, 1, I, O, 0)"),
  count: z.number().int().min(1).max(10).default(1).describe("Number of passwords to generate"),
});

const PassphraseParams = z.object({
  words: z.number().int().min(3).max(10).default(4).describe("Number of words"),
  separator: z.string().default("-").describe("Word separator"),
  capitalize: z.boolean().default(true).describe("Capitalize first letter of each word"),
  includeNumber: z.boolean().default(true).describe("Append a random number"),
});

const StrengthParams = z.object({
  password: z.string().describe("Password to analyze"),
});

// Common word list for passphrases (subset for size)
const WORDLIST = [
  "apple", "arrow", "badge", "beach", "blade", "blaze", "board", "brave", "brick", "brush",
  "cabin", "candy", "chain", "chase", "chief", "cloud", "coast", "coral", "crane", "crest",
  "dance", "delta", "dream", "drift", "eagle", "earth", "ember", "fable", "flame", "flash",
  "frost", "ghost", "globe", "grace", "grain", "grape", "guard", "Haven", "heart", "honey",
  "ivory", "jewel", "joker", "karma", "knack", "lance", "lemon", "light", "lunar", "maple",
  "marsh", "melon", "metal", "mirth", "night", "noble", "ocean", "olive", "onion", "orbit",
  "panda", "pearl", "pilot", "plant", "plume", "polar", "prime", "prism", "pulse", "queen",
  "quest", "radar", "raven", "ridge", "river", "robin", "royal", "scale", "scout", "shade",
  "shark", "shelf", "shine", "sigma", "solar", "spark", "spear", "spike", "spine", "steam",
  "stone", "storm", "sugar", "surge", "sword", "table", "tiger", "torch", "tower", "trail",
  "tulip", "ultra", "union", "vapor", "vault", "venus", "vigor", "viola", "viper", "vivid",
  "watch", "whale", "wheat", "wings", "worth", "yield", "zebra", "bliss", "cedar", "dingo",
];

const passwordGeneratorSkill: SkillDefinition = {
  name: "password_generator",
  version: "1.0.0",

  manifest: {
    id: "password_generator",
    name: "Password Generator",
    description: "Generate cryptographically secure passwords and passphrases. Analyze password strength.",
    category: "execute",
    tools: ["password_generate", "passphrase_generate", "password_strength"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "password_generate",
      description: "Generate one or more cryptographically secure random passwords.",
      parameters: PasswordParams,

      async execute(params) {
        let charset = "";
        if (params.includeLowercase) charset += "abcdefghijklmnopqrstuvwxyz";
        if (params.includeUppercase) charset += "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        if (params.includeNumbers) charset += "0123456789";
        if (params.includeSymbols) charset += "!@#$%^&*()_+-=[]{}|;:,.<>?";

        if (params.excludeAmbiguous) {
          charset = charset.replace(/[l1IO0]/g, "");
        }

        if (charset.length === 0) return { error: "No character types selected." };

        const passwords = [];
        for (let p = 0; p < params.count; p++) {
          const bytes = randomBytes(params.length);
          let password = "";
          for (let i = 0; i < params.length; i++) {
            password += charset[bytes[i]! % charset.length];
          }
          passwords.push(password);
        }

        const entropy = Math.round(params.length * Math.log2(charset.length));
        return {
          count: passwords.length,
          length: params.length,
          charsetSize: charset.length,
          entropyBits: entropy,
          passwords,
          strength: entropy >= 128 ? "excellent" : entropy >= 80 ? "strong" : entropy >= 60 ? "moderate" : "weak",
        };
      },
    });

    ctx.registerTool({
      name: "passphrase_generate",
      description: "Generate a memorable passphrase from random words.",
      parameters: PassphraseParams,

      async execute(params) {
        const words = [];
        for (let i = 0; i < params.words; i++) {
          const idx = randomInt(WORDLIST.length);
          let word = WORDLIST[idx]!;
          if (params.capitalize) word = word[0]!.toUpperCase() + word.slice(1);
          words.push(word);
        }

        let passphrase = words.join(params.separator);
        if (params.includeNumber) passphrase += params.separator + randomInt(100, 999);

        const entropy = Math.round(params.words * Math.log2(WORDLIST.length) + (params.includeNumber ? 10 : 0));
        return {
          passphrase,
          wordCount: params.words,
          entropyBits: entropy,
          strength: entropy >= 80 ? "excellent" : entropy >= 60 ? "strong" : entropy >= 40 ? "moderate" : "weak",
        };
      },
    });

    ctx.registerTool({
      name: "password_strength",
      description: "Analyze the strength of a password.",
      parameters: StrengthParams,

      async execute(params) {
        const p = params.password;
        const checks = {
          length: p.length,
          hasLowercase: /[a-z]/.test(p),
          hasUppercase: /[A-Z]/.test(p),
          hasNumbers: /\d/.test(p),
          hasSymbols: /[^a-zA-Z0-9]/.test(p),
          noRepeating: !/(.)\1{2,}/.test(p),
          noSequential: !/(?:abc|bcd|cde|def|efg|123|234|345|456|567|678|789)/i.test(p),
        };

        let charsetSize = 0;
        if (checks.hasLowercase) charsetSize += 26;
        if (checks.hasUppercase) charsetSize += 26;
        if (checks.hasNumbers) charsetSize += 10;
        if (checks.hasSymbols) charsetSize += 32;

        const entropy = Math.round(p.length * Math.log2(charsetSize || 1));
        const score = Object.values(checks).filter(Boolean).length;

        let strength: string;
        if (entropy >= 128 && score >= 6) strength = "excellent";
        else if (entropy >= 80 && score >= 5) strength = "strong";
        else if (entropy >= 60 && score >= 4) strength = "moderate";
        else if (entropy >= 40) strength = "weak";
        else strength = "very weak";

        return { ...checks, charsetSize, entropyBits: entropy, score: `${score}/7`, strength };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "password_generator",
      instructions: "You can generate passwords with `password_generate` (random chars), `passphrase_generate` (memorable words), and `password_strength` (analyze existing passwords). All use crypto-grade randomness.",
    };
  },
};

export default passwordGeneratorSkill;
