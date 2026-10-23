import type { MikaOnboardingLanguage } from "@marvis/core/onboarding";

export type MikaContentLang = MikaOnboardingLanguage;

interface LocalizedText {
  en: string;
  zh: string;
  ko: string;
  ja: string;
}

export interface MikaOnboardingDefinition {
  title: string;
  language: MikaContentLang;
}

/**
 * Mika's name, description, avatar, permissions, and system instructions are
 * NOT here — they are server constants delivered by `POST /api/agents/mika`.
 * Keeping them out of the client is what lets Marvis update Mika's prompt by
 * deploying, and stops a client from minting an agent that claims Mika's
 * identity.
 *
 * The chat title stays client-side: it names a session this member is opening,
 * in the language they are currently using.
 */
const MIKA_CHAT_TITLE: LocalizedText = {
  en: "Getting started with Marvis",
  zh: "和 Marvis 开始",
  ko: "Marvis와 시작하기",
  ja: "Marvis と始める",
};

export function getMikaOnboarding(
  lang: MikaContentLang,
): MikaOnboardingDefinition {
  return {
    title: MIKA_CHAT_TITLE[lang],
    language: lang,
  };
}
