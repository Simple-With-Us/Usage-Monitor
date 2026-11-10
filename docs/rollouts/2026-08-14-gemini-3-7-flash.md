# Rollout: Gemini 3.7 Flash pricing lookup

Usage Monitor does not pick models.  It now prices `gemini-3.7-flash` and `gemini-3.7-flash:batch` in the runtime lookup so derived token cost is not unpriced.  The bundled LiteLLM snapshot dump is unchanged.

Gates: `src/lib/__tests__/model-pricing.test.ts` plus `npx tsc --noEmit`.
