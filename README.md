# PreSend

PreSend is a Chrome extension that checks text and supported files for likely sensitive information before they are sent to an AI chat. It combines deterministic detection with a bundled semantic model and presents review actions including Redact, Replace with Safe Example, Send Anyway, and Cancel.

Supported sites:

- ChatGPT
- Claude
- Gemini
- Perplexity
- DeepSeek
- Grok

All scanning runs locally in the browser. PreSend has no account system, telemetry, advertising, backend inference, or runtime model downloads. Optional activity history stores metadata only and is off by default.

## Build

Requires Node.js 20 or later and npm.

```sh
npm install
npm run typecheck
npm test
npm run build
npm run zip
```

The unpacked Chrome MV3 extension is generated in `.output/chrome-mv3`. Load that directory from `chrome://extensions` using **Load unpacked** for local testing.

See [PRIVACY.md](PRIVACY.md) for data-handling details.
