# Reader content pipeline

The application shell does not parse ebook formats itself. It asks the reader adapter for a normalized document, then renders chapters and blocks.

```text
EPUB / TXT file
      ↓
reader/index.js                 format adapter boundary
      ├── text-parser.js         TXT chapter and paragraph detection
      └── epub-parser.js         EPUB package, TOC, spine and illustrations
              ↓
              archive.js                 ZIP entries and EPUB-relative paths
              ↓
{ chapters: [{ id, title, depth, blocks }], objectUrls }
              ↓
app.js reader view               TOC, chapter navigation, inline images, gallery,
                                  bookmarks, notes, page-turn mode and reading progress
```

Block types are `paragraph` (`value`) and `image` (`src`, `alt`). This lets the reader add headings, notes, audio, and other media without teaching the UI how to inspect an EPUB ZIP file.

## Current support

- TXT: UTF-8, GB18030, Big5, Shift_JIS, and UTF-16 LE selection, common Chinese/Japanese/English chapter headings, blank-line or line-based paragraph boundaries, and a single-chapter fallback. The reader settings panel previews chapter rules before applying them; the chosen encoding and rule are stored per book.
- EPUB: OPF spine order, EPUB 3 navigation or NCX labels with spine-heading fallback, and local inline images from the package. The illustration gallery keeps chapter context, offers fit/original-size viewing, keyboard navigation, and a jump back to the inline image. Original EPUB files are read only.
- PDF: stays in the native browser PDF preview; it does not use the reflowable chapter pipeline.
- Reader controls: per-book font size, line height, text width, paragraph indentation and paper theme are stored with that book record. Bookmarks store the chapter and scroll offset in the app database.
- Reading movement: scroll-to-turn-page is the default and advances by a screenful with a brief page-curl cue; continuous scrolling is also available per book. The bottom progress slider seeks through the whole book.
- Notes and speech: selected text can be saved with a note in the local book record; browser speech synthesis reads the current chapter when an OS voice is available.

## Current limits

Preserving EPUB CSS/layout exactly, EPUB audio/video playback, notes/highlights, global style presets, and PDF annotations still need dedicated stages. TXT headings with unusual layouts may still need a custom regular expression.
