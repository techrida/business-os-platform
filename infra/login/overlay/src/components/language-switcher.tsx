"use client";

import { setLanguageCookie } from "@/lib/cookies";
import { Lang } from "@/lib/i18n";
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Language dropdown in the footer. Replaces the upstream file of the same name (the overlay is copied over the
 * patched source). It matches the product Select (apps/workspace/src/components/ui/select.tsx): bordered trigger,
 * 8px radius, chevron that turns when open, a floating list with a tick on the chosen row. Styling is plain
 * `bos-lang*` CSS in styles/bos-form.css; nothing depends on the upstream Tailwind theme.
 * Headless UI's Listbox supplies the listbox roles, arrow keys, type-ahead, Escape and focus return.
 */
export function LanguageSwitcher({ languages }: { languages: Lang[] }) {
  const currentLocale = useLocale();
  const [selected, setSelected] = useState(languages.find((l) => l.code === currentLocale) || languages[0]);
  const router = useRouter();

  const handleChange = async (language: Lang) => {
    setSelected(language);
    await setLanguageCookie(language.code);
    router.refresh();
  };

  return (
    <div className="bos-lang">
      <Listbox value={selected} onChange={handleChange}>
        <ListboxButton className="bos-lang__trigger" aria-label="Language">
          <span className="bos-lang__value">{selected.name}</span>
          <svg
            className="bos-lang__chevron"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </ListboxButton>
        <ListboxOptions anchor={{ to: "top end", gap: 8 }} className="bos-lang__list">
          {languages.map((lang) => (
            <ListboxOption key={lang.code} value={lang} className="bos-lang__item">
              <span className="bos-lang__label">{lang.name}</span>
              <svg
                className="bos-lang__tick"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </ListboxOption>
          ))}
        </ListboxOptions>
      </Listbox>
    </div>
  );
}
