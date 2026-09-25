# PreSend Privacy

PreSend reads text entered in supported AI chat composers so it can check the content before submission. When file protection is available, it also reads selected supported files before upload.

Deterministic scanning and semantic inference run locally in the browser. The semantic model and tokenizer are bundled with the extension. Prompt text, file contents, and detected values are not sent to PreSend servers. PreSend does not include telemetry, advertising, tracking, or remote logging.

Activity history is optional and off by default. When enabled, it stores metadata such as time, site, category, severity, action, and finding count. It does not store prompts, file contents, detected values, or previews. Feedback stores detector metadata and salted fingerprints used for exact-value allowlisting; raw secrets are not intentionally persisted.

Use **Clear All PreSend Data** in Settings to remove local settings, history, feedback, allowlists, salts, and onboarding state. Uninstalling the extension also removes its browser-managed local storage.
