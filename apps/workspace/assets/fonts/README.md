# Memo PDF fonts

Noto Sans (latin, latin-ext, vietnamese, greek, cyrillic) and Noto Sans Devanagari (devanagari), weights 400 and 700,
as the unmodified `.woff` subsets shipped by `@fontsource/noto-sans` and `@fontsource/noto-sans-devanagari`
5.3.0. License: SIL Open Font License 1.1 (`LICENSE-OFL.txt`).

`src/lib/memo-pdf.ts` embeds these into the exported memo PDF so staff and company names print with their real
characters. Characters outside these subsets are replaced with `?` and reported to the user.
Replacing a file is safe; keep the file names in `src/lib/memo-pdf-fonts.ts` in step.
