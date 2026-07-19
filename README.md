# Add a Line / 添一笔

> Add a line. Tear a page.
>
> 把未完成留在手边，随时添一笔。

Add a Line is a small macOS menu-bar notebook for work in progress. It keeps ideas, loose next steps, reference files, and comparisons in one summonable space. The goal is not to force a task system: open it, adjust a few words, add a thought, compare two files, then continue.

![Add a Line app icon](assets/AppIcon-1024.png)

## What It Is For

- Keep temporary ideas and current work close without turning them into a project plan.
- Split one notebook into named panes for parallel thoughts, source material, or comparisons.
- Make a small move whenever the app is open: add a line, revise a note, or save a reference.
- Use it as a flexible whiteboard, an index notebook, or a file comparison pool.

## Features

- Summon or hide the window with `Control + Option + Z`.
- Horizontal, vertical, grid, and free-form pane layouts.
- Resize, reorder, color, pin, maximize, save, and remove individual panes.
- Rich text, strikethrough, images, and drag-and-drop text or images.
- Insert images from files or by dragging from Finder, other apps, or a web page.
- Open Markdown, text, HTML, Word, and image files as panes.
- Save a pane back to its source file, print it, or export Markdown and Word.
- Sort panes by title or modification time in ascending or descending order.
- Keep the window above other apps when needed.

## Install

The current release supports Apple Silicon Macs running macOS 12 or later.

1. Download `Add-a-Line-macOS-arm64.zip` from [Releases](../../releases).
2. Unzip it and move `Add a Line.app` to Applications.
3. Open the app from Finder. Until a Developer ID certificate and notarization are added, macOS may require Control-clicking the app and choosing **Open** once.

Your existing SideNote data remains available after the rename. Add a Line intentionally continues to use:

```text
~/Library/Application Support/sidenote-mac/notebook.json
```

## Privacy

Notes stay on the Mac. Add a Line has no account, sync service, analytics, or telemetry. When you drag a web image into a pane, the app downloads that user-selected image so it can embed it in the local note. See [PRIVACY.md](PRIVACY.md) for details.

## Development

```bash
npm install --ignore-scripts
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
npm start
npm test
npm run package:mac
```

## Contributing

Bug reports, focused feature proposals, and accessibility feedback are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[MIT](LICENSE)
